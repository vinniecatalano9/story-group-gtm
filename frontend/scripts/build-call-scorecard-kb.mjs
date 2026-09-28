#!/usr/bin/env node
// Rebuilds the knowledge base embedded in public/call-scorecard/index.html:
// the instant-search corpus (#kbData) and the case-study library (#casesData).
//
// Run after PR Mastery, the package reference, or Aaron's talking points change:
//   node frontend/scripts/build-call-scorecard-kb.mjs
// (Invoke node directly; npm scripts break under the colon in the OFFERING path.)
//
// Sources outside the repo are optional. A missing one is warned and skipped,
// and whatever is already embedded for it is replaced by the rest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(HERE, '..');
const OFFERING = path.resolve(FRONT, '../..');
const SRC = {
  page: path.join(FRONT, 'public/call-scorecard/index.html'),
  prMastery: path.join(FRONT, 'public/pr-mastery/index.html'),
  // Master doc (supersedes Aaron-Call2-Talking-Points.md as of 2026-07-23).
  aaron: path.join(OFFERING, 'PR Learning Corpus/03_Aaron-StoryGroup-Voice/Aaron-Selling-System.md'),
  packages: path.join(os.homedir(), '.claude/skills/story-group-pitch-call-prep/assets/tier_reference.md'),
  caseIndex: path.join(os.homedir(), '.claude/skills/story-group-discovery-brief/assets/case_studies_index.md'),
};

const read = (p, label) => {
  try { return fs.readFileSync(p, 'utf8'); }
  catch { console.warn(`! ${label} not found, skipped: ${p}`); return null; }
};

const clean = s => String(s ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\*\*/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// Only the final 9/18/2026 packages exist. The sources were cleaned on 2026-09-28; this is
// the safety net that keeps a retired tier, price, or term from sneaking back into search.
// Case-sensitive on purpose: "essential" and "a foundation" are ordinary words.
const RETIRED_NAMES = /\b(Amplify|Essential)\b|\bFoundation\s*(tier|package|plan|\(|\$|—\s*\$|at \$)|\$5K Foundation|\bInfluence\s*(tier|\(\$|\$1[45])|\bCommand\s*(\(\$2[25]|\$2[25]K)/;
const RETIRED_TERMS = /four-month|4-month|\b4-mo\b|price rule/i;
const isRetired = d => RETIRED_NAMES.test(`${d.h} ${d.b}`) || RETIRED_TERMS.test(`${d.h} ${d.b}`);

/* ---------- PR Mastery: JS literals in the page script ---------- */
function literalAfter(src, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*`).exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (q) { if (ch === '\\') { j++; continue; } if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if ((ch === ']' || ch === '}') && --depth === 0) return vm.runInNewContext(`(${src.slice(i, j + 1)})`);
  }
  return null;
}

function fromPrMastery(html) {
  const docs = [];
  const get = n => literalAfter(html, n) || (console.warn(`! PR Mastery: ${n} not found`), []);

  for (const o of get('OBJ')) docs.push({ k: 'Objection', h: clean(o.q), b: clean(o.a) });
  for (const o of get('QA')) docs.push({ k: 'Q&A', h: clean(o.q), b: clean(o.a) });
  for (const d of get('DECKS')) for (const c of d.cards) docs.push({ k: 'Aaron', g: d.name, h: clean(c.q), b: clean(c.a) });
  for (const ind of get('INDUSTRY')) {
    docs.push({ k: 'Industry', g: ind.name, h: `${ind.name}: why PR matters now`,
      b: clean([ind.tag, ...(ind.why || []), 'What\'s at stake:', ...(ind.stake || []), ind.buyer ? `Buyer: ${ind.buyer}` : ''].join('\n')) });
    if (ind.angles?.length) docs.push({ k: 'Industry', g: ind.name, h: `${ind.name}: lines that land`, b: clean(ind.angles.join('\n\n')) });
    for (const [q, a] of ind.objs || []) docs.push({ k: 'Objection', g: ind.name, h: clean(q), b: clean(a) });
  }
  for (const [v, list] of get('MEDIA_VERT')) docs.push({ k: 'Outlets', g: v, h: `Target outlets: ${v}`, b: clean(list) });
  for (const [t, d] of get('GLOSS')) docs.push({ k: 'Glossary', h: clean(t), b: clean(d) });

  const m = html.match(/<script[^>]*id="casesData"[^>]*>([\s\S]*?)<\/script>/);
  const cases = m ? JSON.parse(m[1]) : (console.warn('! PR Mastery: casesData not found'), []);
  return { docs, cases };
}

/* ---------- Markdown → one doc per bullet / table row / paragraph ---------- */
function fromMarkdown(md, kind, skipSections = []) {
  const docs = [];
  let h2 = '', h3 = '', buf = [], header = null;
  const skip = () => !h2 || skipSections.some(s => h2.toLowerCase().startsWith(s));
  const flush = () => {
    const text = buf.join(' ').trim();
    buf = [];
    if (!text || skip()) return;
    const bold = text.match(/^\s*(?:[-*]|\d+\.)?\s*\*\*(.+?)\*\*/);
    let body = clean(text.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
    // Drop the bold lead-in from the body when it's just the heading again.
    // No bold lead-in: the first sentence is a better heading than the section name.
    const first = body.split(/(?<=[.!?:])\s/)[0];
    const h = bold ? clean(bold[1]).replace(/[:.]$/, '') : first.length > 90 ? first.slice(0, 89).replace(/\s+\S*$/, '') + '…' : first;
    if (bold && body.startsWith(h)) body = body.slice(h.length).replace(/^[\s:.—–-]+/, '') || body;
    docs.push({ k: kind, g: h2, h, b: body });
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^#\s/.test(line)) { flush(); continue; }
    if (/^##\s/.test(line)) { flush(); h2 = line.replace(/^##\s+/, '').replace(/^(PART\s+\d+|\d+\.)\s*[—–-]?\s*/i, '').trim(); h3 = ''; header = null; continue; }
    if (/^###\s/.test(line)) { flush(); h3 = line.replace(/^###\s+/, '').trim(); continue; }
    if (/^\|/.test(line)) {
      flush();
      const cells = line.split('|').slice(1, -1).map(c => clean(c));
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      if (!header) { header = cells; continue; }
      if (skip()) continue;
      docs.push({ k: kind, g: h2, h: cells[0], b: cells.slice(1).map((c, i) => c && `${header[i + 1] || ''}: ${c}`).filter(Boolean).join('\n') });
      continue;
    }
    header = /^\s*$/.test(line) ? null : header;
    if (/^\s*$/.test(line) || /^---+$/.test(line)) { flush(); continue; }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) { flush(); buf.push(line); continue; }
    buf.push(line.replace(/^\s*>\s?/, '').trim());
  }
  flush();
  return docs;
}

/* ---------- Case studies: attach the challenge pattern + full title ---------- */
function withPatterns(cases, indexMd) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const rows = indexMd ? indexMd.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l)).map(l => l.split('|').map(c => c.trim())) : [];
  return cases.map(c => {
    const row = rows.find(r => norm(r[5] || '').startsWith(norm(c.title)));
    return { i: c.industry, t: row ? row[5] : c.title, p: row ? row[4] : '', s: c.sec, c: clean(c.challenge), m: c.metrics };
  });
}

/* ---------- Gaps in the sources, written from existing doctrine ---------- */
// Keep these short and traceable to Aaron's selling system or the discovery skill.
const SUPPLEMENT = [
  { k: 'Objection', g: 'Story Group doctrine', h: '"We got burned by a PR firm before"',
    b: 'Discovery (burned-skeptical pattern): "Fair concern. Here\'s how we work differently, and you can verify it before you sign." Then ask: "What were you promised, and what did you actually get?" Their answer is your Call 2 contrast.\n'
     + 'Contrast points (Aaron): we pitch as the CEO, from your own identity with your approval (about 4% higher return on feature pitches). Every pitch is personalized, nothing cookie-cutter. We report earned media value against the retainer, and no client gets less EMV than they pay us. 97% stay after the minimum because they want to, not because they\'re locked in.' },
];

/* ---------- build ---------- */
const page = read(SRC.page, 'call-scorecard page');
if (!page) process.exit(1);

const pr = fromPrMastery(read(SRC.prMastery, 'PR Mastery') || '');
const aaron = read(SRC.aaron, 'Aaron talking points');
const pkgs = read(SRC.packages, 'package reference');
const cases = withPatterns(pr.cases, read(SRC.caseIndex, 'case study index'));

const all = [
  ...SUPPLEMENT,
  ...(pkgs ? fromMarkdown(pkgs, 'Package', ['contents']) : []),
  ...pr.docs,
  ...(aaron ? fromMarkdown(aaron, 'Aaron') : []),
  ...cases.map(c => ({ k: 'Case', g: c.i, h: c.t, b: `${c.p ? c.p + '\n' : ''}${c.c}\n${c.m.map(([a, b]) => `${a}: ${b}`).join('\n')}` })),
].filter(d => d.h && d.b);
const dropped = all.filter(isRetired);
if (dropped.length) {
  console.warn(`! Dropped ${dropped.length} entries that still use retired tiers or terms. Fix them at the source:`);
  dropped.forEach(d => console.warn(`  - [${d.k}] ${d.h.slice(0, 90)}`));
}
const docs = all.filter(d => !isRetired(d));

const json = v => JSON.stringify(v).replace(/<\//g, '<\\/');
let out = page;
for (const [id, data] of [['kbData', docs], ['casesData', cases]]) {
  const re = new RegExp(`(<script type="application/json" id="${id}">)[\\s\\S]*?(</script>)`);
  if (!re.test(out)) { console.error(`x #${id} block missing from the page`); process.exit(1); }
  out = out.replace(re, (_, a, b) => a + json(data) + b);
}
fs.writeFileSync(SRC.page, out);

const counts = docs.reduce((a, d) => ((a[d.k] = (a[d.k] || 0) + 1), a), {});
console.log(`✓ ${docs.length} search entries`, counts, `· ${cases.length} case studies`);

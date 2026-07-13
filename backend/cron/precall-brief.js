const fs = require('fs');
const path = require('path');
const { getTodaysEvents } = require('../services/calendar');
const { scrapeWebsite, searchNews, searchGoogle } = require('../services/apify');
const { claudePrompt } = require('../services/claude');
const { sendMail, isConfigured } = require('../services/mailer');

const TEAM_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'fireflies.ai', 'group.calendar.google.com', 'resource.calendar.google.com'];
const FREE_MAIL = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com', 'mac.com'];
const INTERNAL_TITLES = /l10|leadership|standup|team meeting|one on one|1:1|internal|sameer|web team|invoicing/i;
const DISCOVERY_TITLES = /discovery|intro|solutions call|strategy call|story ?group &/i;

const RECIPIENTS = () => (process.env.BRIEF_RECIPIENTS || 'vincent@storygroup.io,mmoonan@storygroup.io').split(',').map(s => s.trim());

/** Condensed case-study library from the PR Mastery knowledge base. */
function loadCaseStudies() {
  try {
    const p = path.join(__dirname, '../../frontend/public/pr-mastery/index.html');
    const src = fs.readFileSync(p, 'utf8');
    const m = src.match(/<script[^>]*id="casesData"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return '';
    const cases = JSON.parse(m[1]);
    return cases.map(c =>
      `- [${c.industry}] "${c.title}" — ${(c.metrics || []).map(x => Array.isArray(x) ? `${x[0]}: ${x[1]}` : String(x)).join('; ')}`
    ).join('\n');
  } catch (e) {
    console.warn('[precall-brief] Case study load failed:', e.message);
    return '';
  }
}

function prospectsOf(event) {
  return event.attendees.filter(a => {
    const domain = a.email.split('@')[1];
    return !TEAM_DOMAINS.includes(domain) && !a.email.includes('vincent') && !a.email.includes('vinnie');
  });
}

/** Research one prospect: site scrape + news + person search. Degrades gracefully. */
async function research(prospect, event) {
  const domain = prospect.email.split('@')[1];
  const hasCompanySite = !FREE_MAIL.includes(domain);
  // "Story Group & Acme Discovery Call" -> "Acme"
  const companyFromTitle = (event.title.match(/story ?group\s*[&x]\s*(.+?)(?:\s+(?:discovery|intro|solutions|strategy).*)?$/i) || [])[1];
  const company = companyFromTitle || (hasCompanySite ? domain.split('.')[0] : null);

  const out = { domain: hasCompanySite ? domain : null, company, website: null, news: null, person: null };

  if (hasCompanySite) {
    try { out.website = await scrapeWebsite(domain); }
    catch (e) { console.warn(`[precall-brief] Site scrape failed for ${domain}:`, e.message); }
  }
  if (company) {
    try {
      const pages = await searchNews(company);
      const items = pages.flatMap(p => p.organicResults || []);
      out.news = items.map(n => `${n.title || ''}: ${n.description || n.snippet || ''}`).join('\n').substring(0, 3000) || null;
    } catch (e) { console.warn(`[precall-brief] News search failed for ${company}:`, e.message); }
  }
  try {
    const q = prospect.name ? `"${prospect.name}" ${company || domain}` : `"${prospect.email}"`;
    const pages = await searchGoogle(q);
    const items = pages.flatMap(p => p.organicResults || []);
    out.person = items.map(n => `${n.title || ''}: ${n.description || n.snippet || ''}`).join('\n').substring(0, 2000) || null;
  } catch (e) { console.warn('[precall-brief] Person search failed:', e.message); }

  return out;
}

function briefPrompt(event, prospect, r, caseLibrary) {
  const timeET = new Date(event.start).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return `You are prepping Vincent Catalano (VP of Growth, Story Group — earned media/PR for executives, $5K-$25K/mo retainers) for a sales call TODAY at ${timeET} ET.

CALL: "${event.title}"
PROSPECT: ${prospect.name || prospect.email} <${prospect.email}>
COMPANY: ${r.company || 'unknown'} ${r.domain ? `(${r.domain})` : ''}

WEBSITE CONTENT:
${r.website || 'Not available'}

RECENT NEWS:
${r.news || 'None found'}

ABOUT THE PERSON:
${r.person || 'Nothing found'}

STORY GROUP ICP (for fit scoring): CEOs/founders/C-suite of real companies with teams (NOT solo operators, coaches, or self-employed consultants). Sweet spot: $8K-$14K/mo retainers. They need media visibility, thought leadership, or reputation defense. Red flags: no company website, "I help X do Y" positioning, single-person practice.

CASE STUDY LIBRARY (pick ONE that best matches their industry/situation — cite it exactly, or say "no strong match"):
${caseLibrary || 'Not available'}

Write a pre-call brief in EXACTLY this format (plain text, no markdown symbols):

WHO THEY ARE
2-3 sentences: person, role, what the company does, size/stage signals.

WHY PR NOW
2-3 sentences: the strongest trigger you can find (news, launch, growth, competitive pressure, reputation issue). If nothing found, say what to probe for on the call.

ICP FIT: X/10
One sentence justifying the score. Flag solo-operator risk explicitly if present.

LIKELY OBJECTIONS
The 2-3 objections THIS prospect will most likely raise given their industry/stage, each with a one-line response Vincent can use.

CASE STUDY TO OPEN WITH
The one case from the library that matches, with its exact numbers, and one sentence on how to frame it for this prospect.

Keep the whole brief under 350 words. Be specific — use their words from the website/news, never generic filler.`;
}

async function runPrecallBrief({ send = true } = {}) {
  const events = await getTodaysEvents();
  const caseLibrary = loadCaseStudies();

  // Prospect calls only: external attendee + not obviously internal
  const calls = events
    .map(e => ({ event: e, prospects: prospectsOf(e) }))
    .filter(c => c.prospects.length > 0 && !INTERNAL_TITLES.test(c.event.title));

  console.log(`[precall-brief] ${events.length} events today, ${calls.length} prospect call(s)`);
  if (calls.length === 0) return { calls: 0, sent: false };

  const briefs = [];
  for (const { event, prospects } of calls) {
    const prospect = prospects[0];
    const isDiscovery = DISCOVERY_TITLES.test(event.title);
    try {
      console.log(`[precall-brief] Researching ${prospect.email} for "${event.title}"...`);
      const r = await research(prospect, event);
      const brief = await claudePrompt(briefPrompt(event, prospect, r, caseLibrary), { timeout: 180000 });
      briefs.push({ event, prospect, isDiscovery, brief });
      console.log(`[precall-brief] Brief ready for "${event.title}"`);
    } catch (e) {
      console.error(`[precall-brief] Failed for "${event.title}":`, e.message);
      briefs.push({ event, prospect, isDiscovery, brief: `Brief generation failed: ${e.message}\nProspect: ${prospect.email}` });
    }
  }

  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
  const html = `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
  <h2 style="color:#FF2257">Pre-Call Briefs — ${dateStr}</h2>
  <p style="color:#666">${briefs.length} prospect call${briefs.length > 1 ? 's' : ''} on the Story Group calendar today.</p>
  ${briefs.map(b => `
  <div style="border:1px solid #e0e0e8;border-radius:8px;padding:20px;margin:16px 0">
    <div style="font-size:16px;font-weight:bold">${new Date(b.event.start).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET — ${b.event.title}</div>
    <div style="color:#666;font-size:13px;margin:4px 0 12px">${b.prospect.name ? b.prospect.name + ' · ' : ''}${b.prospect.email}${b.isDiscovery ? ' · <span style="color:#FF2257;font-weight:bold">DISCOVERY CALL</span>' : ''}</div>
    <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.5;margin:0">${b.brief.replace(/</g, '&lt;')}</pre>
  </div>`).join('')}
</div>`;

  const result = { calls: briefs.length, sent: false, briefs: briefs.map(b => ({ title: b.event.title, to: b.prospect.email })) };

  if (send) {
    if (!isConfigured()) {
      console.warn('[precall-brief] SMTP not configured — brief generated but not emailed');
      result.error = 'SMTP_USER/SMTP_PASS not set';
      result.html = html;
    } else {
      await sendMail({
        to: RECIPIENTS(),
        subject: `Pre-Call Briefs: ${briefs.length} call${briefs.length > 1 ? 's' : ''} today (${dateStr})`,
        html,
      });
      result.sent = true;
    }
  } else {
    result.html = html;
  }

  return result;
}

module.exports = { runPrecallBrief };

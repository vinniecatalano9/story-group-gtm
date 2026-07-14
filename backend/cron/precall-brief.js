const fs = require('fs');
const path = require('path');
const { getTodaysEvents } = require('../services/calendar');
const { scrapeWebsite, searchNews, searchGoogle } = require('../services/apify');
const { claudePrompt } = require('../services/claude');
const { sendMail, isConfigured } = require('../services/mailer');
const { transcripts } = require('../services/db');
const fireflies = require('../services/fireflies');

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
      `- [${c.industry}] "${c.title}" — challenge: ${(c.challenge || '').substring(0, 160).replace(/\s+/g, ' ')}… — results: ${(c.metrics || []).map(x => Array.isArray(x) ? `${x[0]}: ${x[1]}` : String(x)).join('; ')}`
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

/**
 * Prior calls with any of these prospect emails (Call 2 detection).
 * Case-insensitive scan of recent stored transcripts.
 */
async function findPriorCalls(prospectEmails) {
  const wanted = prospectEmails.map(e => e.toLowerCase());
  const snap = await transcripts.orderBy('date', 'desc').limit(200).get();
  const today = new Date().toISOString().slice(0, 10);
  return snap.docs
    .map(d => d.data())
    .filter(t => (t.date || '').slice(0, 10) < today)
    .filter(t => (t.participants || []).some(p => wanted.includes(String(p).toLowerCase().trim())));
}

const TIER_FACTS = `STORY GROUP TIERS (canonical, June 2026):
- Foundation $5K/mo — REACTIVE ONLY: responds to inbound journalist queries, newsjacking, up to 2 media advisories/mo. NO proactive pitching. 4-mo minimum.
- Amplify $8.5K/mo — proactive outbound pitching starts here: 1-2 narratives, 50-75 outlet media list, persistent outreach. 4-mo minimum.
- Influence $15K/mo — adds podcasts, up to 2 TV/radio + 2 speaking pitches/mo, rapid response, full intelligence suite. 4-mo minimum.
- Command $25K/mo — by invitation only: dedicated senior strategist, uncapped placements, in-home broadcast studio, crisis counsel. 12-mo minimum.
Never promise proactive pitching or placement counts at Foundation.`;

function call2Prompt(event, prospect, priorCalls, priorSentences, r, caseLibrary) {
  const timeET = new Date(event.start).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const lastCall = priorCalls[0];
  return `You are prepping Vincent Catalano (VP of Growth, Story Group — earned media/PR for executives) for a SOLUTIONS CALL (Call 2 — the pitch and close) TODAY at ${timeET} ET. They already had a discovery call; today is about presenting the plan and closing on a tier.

CALL: "${event.title}"
PROSPECT: ${prospect.name || prospect.email} <${prospect.email}>

CALL 1 ("${lastCall.title}", ${lastCall.date?.slice(0, 10)}):
Summary: ${lastCall.overview || 'n/a'}
Action items: ${lastCall.action_items || 'n/a'}

CALL 1 TRANSCRIPT:
${priorSentences || 'Not available — work from the summary above.'}

RECENT NEWS ABOUT THEM:
${r.news || 'None found'}

${TIER_FACTS}

CASE STUDY LIBRARY (pick ONE matching industry + challenge pattern; adjacent industry if no exact match — there is virtually always a match):
${caseLibrary || 'Not available'}

Write a Call 2 prep brief in EXACTLY this format (plain text, no markdown symbols):

CALL 1 RECAP
3-4 sentences: their situation, their pain, their goal — using THEIR words from the transcript.

COMMITMENTS ON THE TABLE
What we promised to bring today, and what they committed to (decision-maker present? budget discussed? timeline?). Flag anything Vincent promised that he must have ready.

RECOMMENDED TIER: [tier name + price]
2-3 sentences on why this tier matches their stakes, referencing what they said on Call 1.

LIKELY OBJECTIONS AT THE CLOSE
The 2-3 most likely objections THIS prospect will raise when asked to commit (price, timing, "need to think," spouse/partner sign-off), each with a one-line response drawn from what they said on Call 1.

CASE STUDY TO REINFORCE
The one library case that matches, with exact numbers, framed for the close ("this is what month 4 looks like").

WATCH-OUTS
1-2 open questions from Call 1 that could derail the close if unaddressed.

Keep it under 400 words. Use their exact words wherever possible.`;
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

CASE STUDY LIBRARY (pick ONE — match on BOTH industry AND challenge pattern: launch, crisis, recovery, positioning, authority-building, regulatory, down-market, etc. If the exact industry isn't in the library, pick the closest ADJACENT industry and match on challenge pattern — with this 40-case library there is virtually always a match, so "no match" should be extremely rare. Cases are anonymized by design — cite as industry + descriptor, never invent a client name, never fabricate numbers):
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
    const titleSaysSolutions = /solutions|follow.?up call|call 2|second call/i.test(event.title);
    let callType = DISCOVERY_TITLES.test(event.title) ? 'discovery' : 'prospect call';
    try {
      // Call 2 detection: prior transcript with any attendee, or the title says so
      const priorCalls = await findPriorCalls(prospects.map(p => p.email));
      if (priorCalls.length > 0) callType = 'solutions';
      else if (titleSaysSolutions) callType = 'solutions (no Call 1 transcript on file)';

      let brief;
      if (priorCalls.length > 0) {
        console.log(`[precall-brief] "${event.title}" is a CALL 2 (${priorCalls.length} prior call(s)) — prepping the close...`);
        let priorSentences = null;
        try {
          const { transcriptText } = require('../services/followupDrafter');
          const full = await fireflies.getTranscript(priorCalls[0].fireflies_id);
          priorSentences = transcriptText(full);
        } catch (e) { console.warn('[precall-brief] Prior transcript fetch failed:', e.message); }
        // Call 2 prep leans on the Call 1 transcript; skip the site scrape
        let r = { news: null };
        try {
          const company = (event.title.match(/story ?group\s*[&x]\s*(.+?)(?:\s+(?:discovery|intro|solutions|strategy).*)?$/i) || [])[1];
          if (company) {
            const pages = await searchNews(company);
            const items = pages.flatMap(p => p.organicResults || []);
            r.news = items.map(n => `${n.title || ''}: ${n.description || n.snippet || ''}`).join('\n').substring(0, 3000) || null;
          }
        } catch (e) { console.warn('[precall-brief] News search failed:', e.message); }
        brief = await claudePrompt(call2Prompt(event, prospect, priorCalls, priorSentences, r, caseLibrary), { timeout: 180000 });
      } else {
        console.log(`[precall-brief] Researching ${prospect.email} for "${event.title}"...`);
        const r = await research(prospect, event);
        brief = await claudePrompt(briefPrompt(event, prospect, r, caseLibrary), { timeout: 180000 });
      }
      briefs.push({ event, prospect, callType, brief });
      console.log(`[precall-brief] Brief ready for "${event.title}"`);
    } catch (e) {
      console.error(`[precall-brief] Failed for "${event.title}":`, e.message);
      briefs.push({ event, prospect, callType, brief: `Brief generation failed: ${e.message}\nProspect: ${prospect.email}` });
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
    <div style="color:#666;font-size:13px;margin:4px 0 12px">${b.prospect.name ? b.prospect.name + ' · ' : ''}${b.prospect.email} · <span style="color:${b.callType.startsWith('solutions') ? '#FF743F' : '#FF2257'};font-weight:bold">${b.callType.toUpperCase()}</span></div>
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

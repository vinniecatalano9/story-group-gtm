const fs = require('fs');
const path = require('path');
const { getTodaysEvents } = require('../services/calendar');
const { scrapeWebsite, searchNews, searchGoogle } = require('../services/apify');
const { claudePrompt } = require('../services/claude');
const { sendMail, isConfigured } = require('../services/mailer');
const { transcripts, db } = require('../services/db');
const fireflies = require('../services/fireflies');
const telegram = require('../services/telegram');

const TEAM_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'fireflies.ai', 'group.calendar.google.com', 'resource.calendar.google.com'];
const FREE_MAIL = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com', 'mac.com'];
const INTERNAL_TITLES = /l10|leadership|standup|team meeting|one on one|1:1|internal|sameer|web team|invoicing/i;
const DISCOVERY_TITLES = /discovery|intro|solutions call|strategy call|story ?group &/i;

// McKenna's inbox first; she also books from mckenna@ (same person).
const MCKENNA = (process.env.MCKENNA_EMAILS || 'mmoonan@storygroup.io,mckenna@storygroup.io').split(',').map(s => s.trim().toLowerCase());
const RECIPIENTS = () => (process.env.BRIEF_RECIPIENTS || 'vincent@storygroup.io,mmoonan@storygroup.io').split(',').map(s => s.trim());
// Where the call scorecard lives. Each brief links there with the booking + research pre-filled.
const SCORECARD_URL = () => process.env.SCORECARD_URL || 'https://story-group-gtm.web.app/call-scorecard/';

// Which calls have already been briefed today, by calendar event id.
//
// On 2026-08-17 the 7am tick simply never fired — no log line, no error — and
// four prospect calls went unbriefed. A single daily tick has no way to notice
// that. The catch-up schedule in server.js re-runs this through the day; this
// ledger is what keeps a re-run from re-sending briefs that already went out,
// and it doubles as same-day coverage: a call booked at 10am gets its brief on
// the next pass instead of never.
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const briefLedger = () => db.collection('precall_briefs').doc(dayKey());

async function alreadyBriefed() {
  try {
    const snap = await briefLedger().get();
    return new Set(snap.exists ? (snap.data().event_ids || []) : []);
  } catch (e) {
    // A ledger read failure must not cost Vincent the brief — worst case a
    // duplicate goes out, which is far cheaper than a missing one.
    console.warn('[precall-brief] Ledger read failed:', e.message);
    return new Set();
  }
}

async function recordBriefed(eventIds) {
  try {
    const prior = await alreadyBriefed();
    await briefLedger().set({
      event_ids: [...new Set([...prior, ...eventIds])],
      updated_at: new Date(),
    }, { merge: true });
  } catch (e) {
    console.warn('[precall-brief] Ledger write failed:', e.message);
  }
}

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

// Apify is one shared $39/month account (Vincent's research skills use it too).
// Past the cap every run returns 403 "Monthly usage hard limit exceeded" until
// the cycle resets on the 19th, and briefs came back with no research at all.
// Now: the company site comes from a plain fetch first (free), Apify only fills
// gaps, the first cap 403 turns Apify off for the rest of the run, and the
// brief says research was skipped instead of looking empty.
let apifyCapped = false;
async function viaApify(fn, ...args) {
  if (apifyCapped) throw new Error('skipped, Apify monthly cap hit earlier in this run');
  try {
    return await fn(...args);
  } catch (e) {
    if (/\(403\)|hard limit/i.test(e.message)) apifyCapped = true;
    throw e;
  }
}

/** Free first pass at a company site: homepage + about page, tags stripped. */
async function fetchSiteText(domain) {
  const texts = [];
  for (const url of [`https://${domain}`, `https://${domain}/about`, `https://${domain}/about-us`]) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StoryGroupBrief/1.0)' } });
      if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) continue;
      const text = (await r.text())
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
      if (text.length > 200 && !texts.includes(text.slice(0, 4000))) texts.push(text.slice(0, 4000));
      if (texts.join(' ').length > 6000) break;
    } catch { /* try the next page */ }
  }
  return texts.join('\n\n').substring(0, 8000) || null;
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

  const out = { domain: hasCompanySite ? domain : null, company, website: null, news: null, person: null, newsTitles: [], personTitles: [], linkedin: null };

  if (hasCompanySite) {
    out.website = await fetchSiteText(domain);
    if (!out.website || out.website.length < 500) {
      try { out.website = (await viaApify(scrapeWebsite, domain)) || out.website; }
      catch (e) { console.warn(`[precall-brief] Site scrape failed for ${domain}:`, e.message); }
    }
  }
  if (company) {
    try {
      const pages = await viaApify(searchNews, company);
      const items = pages.flatMap(p => p.organicResults || []);
      out.news = items.map(n => `${n.title || ''}: ${n.description || n.snippet || ''}`).join('\n').substring(0, 3000) || null;
      out.newsTitles = items.map(n => n.title).filter(Boolean).slice(0, 3);
    } catch (e) { console.warn(`[precall-brief] News search failed for ${company}:`, e.message); }
  }
  try {
    const q = prospect.name ? `"${prospect.name}" ${company || domain}` : `"${prospect.email}"`;
    const pages = await viaApify(searchGoogle, q);
    const items = pages.flatMap(p => p.organicResults || []);
    out.person = items.map(n => `${n.title || ''}: ${n.description || n.snippet || ''}`).join('\n').substring(0, 2000) || null;
    out.personTitles = items.map(n => n.title).filter(Boolean).slice(0, 2);
    // "Jane Doe - CEO - Acme | LinkedIn" -> "CEO"
    const li = items.find(n => /linkedin\.com\/in\//i.test(n.url || ''));
    if (li) out.linkedin = { url: li.url, title: ((li.title || '').split(' | ')[0].split(' - ')[1] || '').trim() || null };
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

const TIER_FACTS = `STORY GROUP PACKAGES (final 9/18/2026 package doc, the only valid pricing; Start-here prices):
- Kickstart $5,500 one-time: audit, positioning, messaging, 30/60/90 roadmap. No PR outreach.
- Business Growth Engagement $7,500/mo, 3 months: Google Ads, conversion, qualified leads. No PR.
- Visibility $10,000/mo, 6 months: PR and earned media, proactive pitching, podcast bookings, newsjacking, monitoring. No digital growth.
- Influence $20,000/mo, 6 months: growth engine plus multiple narratives, top-tier outreach, broadcast and speaking pitching, executive positioning.
- Command $30,000/mo, 12 months: senior strategist, premium and national media, reputation, crisis readiness and counsel.
- Command & Digital Growth $33,500/mo, 12 months: Command plus digital growth.
- Premium Cinema add-on $20,000/mo, 12 months ($12,500/mo with Influence or Command): TV spot, promo video, studio, weekly social clips.
Recommend ONE package at its Start-here price. Never quote lower ladder prices or promise placement counts.`;

/** Calendar invite text without links, dial-ins, and scheduler boilerplate: what's left is what they told us. */
function cleanInvite(description) {
  return String(description || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map(l => l.trim())
    .filter(l => l && !/https?:\/\/|meet\.google|zoom\.us|calendly\.com|^(join|dial|passcode|meeting id|need to make changes|cancel|reschedule|powered by|phone|tel)\b/i.test(l))
    .join('\n');
}

/**
 * Link that opens the call scorecard pre-filled with the booking + research.
 * The payload rides in the URL fragment, which browsers never send to a server.
 */
function scorecardLink(event, prospect, r, callType) {
  const site = String(r.website || '').replace(/\s+/g, ' ').trim();
  const payload = {
    v: 1,
    name: prospect.name || '',
    email: prospect.email,
    company: r.company || '',
    title: (r.linkedin && r.linkedin.title) || '',
    website: r.domain || '',
    linkedin: (r.linkedin && r.linkedin.url) || '',
    mode: callType.startsWith('solutions') ? 'c2' : 'c1',
    event: { title: event.title, start: event.start },
    booking: cleanInvite(event.description).slice(0, 1500),
    research: {
      site: site.length > 320 ? site.slice(0, 319) + '…' : site,
      news: r.newsTitles || [],
      person: r.personTitles || [],
    },
  };
  return `${SCORECARD_URL()}#prefill=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

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

Keep it under 400 words. Use their exact words wherever possible. No em dashes or en dashes.`;
}

function briefPrompt(event, prospect, r, caseLibrary) {
  const timeET = new Date(event.start).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return `You are prepping Vincent Catalano (VP of Growth, Story Group — earned media/PR for executives, packages from a $5.5K one-time Kickstart to $33.5K/mo) for a sales call TODAY at ${timeET} ET.

CALL: "${event.title}"
PROSPECT: ${prospect.name || prospect.email} <${prospect.email}>
COMPANY: ${r.company || 'unknown'} ${r.domain ? `(${r.domain})` : ''}

WEBSITE CONTENT:
${r.website || 'Not available'}

RECENT NEWS:
${r.news || 'None found'}

ABOUT THE PERSON:
${r.person || 'Nothing found'}

BOOKING FORM / INVITE NOTES (their own words, if any):
${cleanInvite(event.description).slice(0, 1200) || 'None'}

STORY GROUP ICP (for fit scoring): CEOs/founders/C-suite of real companies with teams (NOT solo operators, coaches, or self-employed consultants). Sweet spot: Visibility ($10K/mo) through Command ($30K/mo); someone who balks at $5K/mo is not the target. They need media visibility, thought leadership, or reputation defense. Red flags: no company website, "I help X do Y" positioning, single-person practice.

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

Keep the whole brief under 350 words. Be specific — use their words from the website/news, never generic filler. No em dashes or en dashes.`;
}

/** One Telegram message per call (HTML mode: only the header and link are markup). */
function telegramText(b, note, withLink = true) {
  const t = (tz) => new Date(b.event.start).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const esc = withLink ? telegram.escapeHtml : (x) => x;
  const who = `${b.prospect.name ? b.prospect.name + ' · ' : ''}${b.prospect.email} · ${b.callType.toUpperCase()}`;
  const head = `📋 Pre-call brief: ${t('America/Chicago')} CT (${t('America/New_York')} ET) · ${b.event.title}`;
  const lines = [withLink ? `<b>${esc(head)}</b>` : head, esc(who)];
  if (note) lines.push(`⚠️ ${esc(note)}`);
  lines.push('', esc(b.brief));
  // A link too long for one message would split the HTML; skip it then.
  if (withLink && b.link && b.link.length < 3000) lines.push('', `<a href="${esc(b.link)}">Open the pre-filled scorecard</a>`);
  return lines.join('\n');
}

async function sendBriefTelegram(b, note) {
  // Before 7am CT, arrive silently.
  const silent = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false })) < 7;
  try {
    await telegram.sendTelegram(telegramText(b, note, true), { html: true, silent });
  } catch (e) {
    // Most likely the scorecard link was too long for one message. Send it plain, no link.
    console.warn(`[precall-brief] Telegram HTML send failed for "${b.event.title}" (${e.message}); retrying plain`);
    await telegram.sendTelegram(telegramText(b, note, false), { silent });
  }
}

async function runPrecallBrief({ send = true, force = false } = {}) {
  apifyCapped = false;
  const events = await getTodaysEvents();
  const caseLibrary = loadCaseStudies();

  // Prospect calls only: external attendee + not obviously internal
  const allCalls = events
    .map(e => ({ event: e, prospects: prospectsOf(e) }))
    .filter(c => c.prospects.length > 0 && !INTERNAL_TITLES.test(c.event.title));

  // getTodaysEvents() starts at now, so calls already underway are out of scope.
  const done = force ? new Set() : await alreadyBriefed();
  const calls = allCalls.filter(c => !done.has(c.event.id));
  const skipped = allCalls.length - calls.length;

  console.log(`[precall-brief] ${events.length} events today, ${allCalls.length} prospect call(s), ${calls.length} to brief${skipped ? ` (${skipped} already briefed)` : ''}`);
  if (calls.length === 0) return { calls: 0, sent: false, alreadyBriefed: skipped };

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

      let brief, link;
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
            const pages = await viaApify(searchNews, company);
            const items = pages.flatMap(p => p.organicResults || []);
            r.news = items.map(n => `${n.title || ''}: ${n.description || n.snippet || ''}`).join('\n').substring(0, 3000) || null;
            r.newsTitles = items.map(n => n.title).filter(Boolean).slice(0, 3);
            r.company = company;
          }
        } catch (e) { console.warn('[precall-brief] News search failed:', e.message); }
        brief = await claudePrompt(call2Prompt(event, prospect, priorCalls, priorSentences, r, caseLibrary), { timeout: 180000 });
        link = scorecardLink(event, prospect, r, callType);
      } else {
        console.log(`[precall-brief] Researching ${prospect.email} for "${event.title}"...`);
        const r = await research(prospect, event);
        brief = await claudePrompt(briefPrompt(event, prospect, r, caseLibrary), { timeout: 180000 });
        link = scorecardLink(event, prospect, r, callType);
      }
      briefs.push({ event, prospect, callType, brief, link });
      console.log(`[precall-brief] Brief ready for "${event.title}"`);
    } catch (e) {
      console.error(`[precall-brief] Failed for "${event.title}":`, e.message);
      briefs.push({ event, prospect, callType, brief: `Brief generation failed: ${e.message}\nProspect: ${prospect.email}`, link: scorecardLink(event, prospect, {}, callType) });
    }
  }

  const dateStr = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
  const renderHtml = (list) => `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e">
  <h2 style="color:#FF2257">Pre-Call Briefs — ${dateStr}</h2>
  <p style="color:#666">${list.length} prospect call${list.length > 1 ? 's' : ''} on the Story Group calendar today.</p>
  ${list.map(b => `
  <div style="border:1px solid #e0e0e8;border-radius:8px;padding:20px;margin:16px 0">
    <div style="font-size:16px;font-weight:bold">${new Date(b.event.start).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET — ${b.event.title}</div>
    <div style="color:#666;font-size:13px;margin:4px 0 12px">${b.prospect.name ? b.prospect.name + ' · ' : ''}${b.prospect.email} · <span style="color:${b.callType.startsWith('solutions') ? '#FF743F' : '#FF2257'};font-weight:bold">${b.callType.toUpperCase()}</span></div>
    ${b.link ? `<a href="${b.link}" style="display:inline-block;background:#FF2257;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px;margin:0 0 12px">Open pre-filled scorecard →</a>` : ''}
    <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.5;margin:0">${b.brief.replace(/</g, '&lt;')}</pre>
  </div>`).join('')}
</div>`;
  const html = renderHtml(briefs);

  const result = { calls: briefs.length, sent: false, telegram: 0, briefs: briefs.map(b => ({ title: b.event.title, to: b.prospect.email })) };
  const note = apifyCapped ? 'Web research partly skipped: Apify monthly cap hit (resets on the 19th).' : null;

  if (send) {
    // Telegram (Work Bot) is Vincent's feed. PRECALL_TELEGRAM=off / PRECALL_EMAIL=off turn either side off.
    const delivered = new Set();
    if (process.env.PRECALL_TELEGRAM !== 'off' && telegram.isConfigured()) {
      const day = dayKey();
      for (const b of briefs) {
        try {
          await sendBriefTelegram(b, note);
          delivered.add(b.event.id);
          result.telegram++;
          const slug = String(b.event.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
          telegram.dropForWorkBot(`precall/${day}-${slug}.md`, `# ${b.event.title}\n${b.event.start}\n${b.prospect.name || ''} <${b.prospect.email}> · ${b.callType}\n\n${b.brief}\n`);
        } catch (e) {
          console.error(`[precall-brief] Telegram send failed for "${b.event.title}":`, e.message);
        }
      }
      if (result.telegram) telegram.noteForWorkBot(`backend sent ${result.telegram} pre-call brief(s) to Vincent on Telegram as you: ${briefs.filter(b => delivered.has(b.event.id)).map(b => b.event.title).join('; ')}. Copies in ~/gtm-feed/precall/. Nothing pending.`);
    }
    // Email (Vincent 10/20): Telegram is his copy. McKenna gets the email only for calls
    // she's on the invite for. PRECALL_EMAIL=all restores the old everyone-every-call email.
    const emailAll = process.env.PRECALL_EMAIL === 'all';
    const forMcKenna = briefs.filter(b => b.event.attendees.some(a => MCKENNA.includes(a.email)));
    const toEmail = emailAll ? briefs : forMcKenna;
    if (process.env.PRECALL_EMAIL !== 'off' && toEmail.length) {
      if (!isConfigured()) {
        console.warn('[precall-brief] SMTP not configured — brief not emailed');
        result.error = 'SMTP_USER/SMTP_PASS not set';
      } else {
        await sendMail({
          to: emailAll ? RECIPIENTS() : [MCKENNA[0]],
          subject: skipped
            ? `Pre-Call Brief — newly booked: ${toEmail.length} call${toEmail.length > 1 ? 's' : ''} (${dateStr})`
            : `Pre-Call Briefs: ${toEmail.length} call${toEmail.length > 1 ? 's' : ''} today (${dateStr})`,
          html: renderHtml(toEmail),
        });
        result.sent = true;
        toEmail.forEach(b => delivered.add(b.event.id));
      }
    }
    if (delivered.size) await recordBriefed([...delivered]);
    else result.html = html;
  } else {
    result.html = html;
  }

  return result;
}

module.exports = { runPrecallBrief };

// lib/meetings.js
//
// Decides whether a Google Calendar event is a sales meeting, and what kind.
//
// This lived inside routes/calendar.js. It moved here the moment a second
// caller (the nightly metrics snapshot) needed it — copying it would have given
// the dashboard and the funnel tab two different definitions of "a meeting",
// and they would have disagreed within a month.
//
// The convention it relies on: sales events are titled "Story Group & <Company>".

const SECOND_CALL_PATTERNS = [
  /solutions?\s+call/i,
  /proposal/i,
  /pitch(?:\s+(?:call|meeting))?/i,
  /close\s+call/i,
  /follow[- ]?up\s+(?:call|meeting)?/i,
  /\b2nd\s*call/i,
  /\bsecond\s+call/i,
];

// Strip noise from company names: time-of-day ("11 AM EST"), date stamps,
// trailing "call" residue after second-call pattern removal.
const COMPANY_NOISE = [
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
  /\b(?:est|edt|cst|cdt|mst|mdt|pst|pdt|utc|gmt)\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\bcall\b\s*$/i,
];

const STORY_GROUP_PREFIX = /^story\s*group\s*[&|/-]\s*/i;
const INTERNAL_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'wrstrategies.com'];
const GENERIC_LOCAL_PARTS = new Set(['info', 'contact', 'hello', 'admin', 'support', 'sales', 'team', 'office', 'hi', 'contactus', 'help']);

/** null if the event isn't a sales meeting, else { callType, company }. */
function classifyEvent(title) {
  if (!title) return null;
  const t = title.trim();
  if (!STORY_GROUP_PREFIX.test(t)) return null;

  const isSecond = SECOND_CALL_PATTERNS.some(rx => rx.test(t));

  let company = t.replace(STORY_GROUP_PREFIX, '');
  SECOND_CALL_PATTERNS.forEach(rx => { company = company.replace(rx, ''); });
  COMPANY_NOISE.forEach(rx => { company = company.replace(rx, ''); });
  company = company.replace(/\s{2,}/g, ' ').replace(/[-–—|/,]+\s*$/, '').trim();

  return { callType: isSecond ? 'second' : 'discovery', company };
}

/** The first non-internal attendee is the prospect. */
function pickProspectFromAttendees(attendees, fallbackCompany) {
  if (!Array.isArray(attendees)) return { prospect: fallbackCompany || '', email: '' };
  const external = attendees.find(a => {
    const email = (a.email || '').toLowerCase();
    if (!email) return false;
    return !INTERNAL_DOMAINS.some(d => email.endsWith('@' + d));
  });
  if (!external) return { prospect: fallbackCompany || '', email: '' };
  if (external.displayName) return { prospect: external.displayName, email: external.email };
  const local = external.email.split('@')[0].toLowerCase().replace(/\d+$/, '');
  if (GENERIC_LOCAL_PARTS.has(local) && fallbackCompany) {
    return { prospect: fallbackCompany, email: external.email };
  }
  return { prospect: external.email.split('@')[0].replace(/[._]/g, ' '), email: external.email };
}

/**
 * Reduce a list of Google Calendar events to sales-meeting counts.
 * `heldBefore` (default now) decides showed-vs-upcoming.
 */
function summarizeMeetings(events, { heldBefore = Date.now() } = {}) {
  const out = {
    total: 0, discovery: 0, second_calls: 0, held: 0, upcoming: 0, cancelled: 0,
    items: [],
  };
  for (const ev of events || []) {
    if (ev.status === 'cancelled') { out.cancelled++; continue; }
    const cls = classifyEvent(ev.summary || '');
    if (!cls) continue;
    const startISO = (ev.start?.dateTime || ev.start?.date || '').slice(0, 10);
    if (!startISO) continue;
    const { prospect, email } = pickProspectFromAttendees(ev.attendees || [], cls.company);
    const endMs = new Date(ev.end?.dateTime || ev.end?.date || ev.start?.dateTime || 0).getTime();
    const held = endMs > 0 && endMs < heldBefore;

    out.total++;
    if (cls.callType === 'second') out.second_calls++; else out.discovery++;
    if (held) out.held++; else out.upcoming++;
    out.items.push({
      eventId: ev.id, date: startISO, prospect: prospect || cls.company,
      company: cls.company, callType: cls.callType, held, prospectEmail: email,
      title: ev.summary || '',
    });
  }
  return out;
}

module.exports = {
  classifyEvent, pickProspectFromAttendees, summarizeMeetings,
  SECOND_CALL_PATTERNS, COMPANY_NOISE, STORY_GROUP_PREFIX,
  INTERNAL_DOMAINS, GENERIC_LOCAL_PARTS,
};

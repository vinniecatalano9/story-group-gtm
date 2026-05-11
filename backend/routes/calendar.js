const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const SECOND_CALL_PATTERNS = [
  /solutions?\s+call/i,
  /proposal/i,
  /pitch(?:\s+(?:call|meeting))?/i,
  /close\s+call/i,
  /follow[- ]?up\s+(?:call|meeting)?/i,
  /\b2nd\s*call/i,
  /\bsecond\s+call/i
];

// Strip noise from company names: time-of-day ("11 AM EST"), date stamps,
// trailing "call" residue after second-call pattern removal.
const COMPANY_NOISE = [
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
  /\b(?:est|edt|cst|cdt|mst|mdt|pst|pdt|utc|gmt)\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\bcall\b\s*$/i
];

const STORY_GROUP_PREFIX = /^story\s*group\s*[&|/-]\s*/i;
const INTERNAL_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'wrstrategies.com'];
const GENERIC_LOCAL_PARTS = new Set(['info','contact','hello','admin','support','sales','team','office','hi','contactus','help']);

let _calendarClient = null;
function getCalendar() {
  if (_calendarClient) return _calendarClient;
  const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
  _calendarClient = google.calendar({ version: 'v3', auth });
  return _calendarClient;
}

function classifyEvent(title) {
  if (!title) return null;
  const t = title.trim();
  if (!STORY_GROUP_PREFIX.test(t)) return null;

  const isSecond = SECOND_CALL_PATTERNS.some(rx => rx.test(t));

  // Company = strip "Story Group & " prefix, then strip trailing call-type keyword
  // and timestamp/timezone noise.
  let company = t.replace(STORY_GROUP_PREFIX, '');
  SECOND_CALL_PATTERNS.forEach(rx => { company = company.replace(rx, ''); });
  COMPANY_NOISE.forEach(rx => { company = company.replace(rx, ''); });
  company = company.replace(/\s{2,}/g, ' ').replace(/[-–—|/,]+\s*$/, '').trim();

  return {
    callType: isSecond ? 'second' : 'discovery',
    company
  };
}

/**
 * Cross-reference a prospect email against Instantly leads.
 * Returns { campaignId, campaignName } if the email exists in any Instantly campaign,
 * otherwise null. Errors are swallowed — attribution is best-effort.
 */
async function lookupInstantlyLead(email) {
  if (!email || !process.env.INSTANTLY_API_KEY) return null;
  try {
    const r = await axios.post('https://api.instantly.ai/api/v2/leads/list', {
      search: email,
      limit: 1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 6000
    });
    const items = r.data?.items || (Array.isArray(r.data) ? r.data : []);
    if (!items.length) return null;
    const lead = items[0];
    return {
      campaignId: lead.campaign || lead.campaign_id || null,
      campaignName: lead.campaign_name || null
    };
  } catch (e) {
    return null;
  }
}

/**
 * Memoize campaign name lookups so we only hit Instantly once per campaign per request.
 */
let _campaignNameCache = null;
async function getInstantlyCampaignName(campaignId) {
  if (!campaignId || !process.env.INSTANTLY_API_KEY) return null;
  if (_campaignNameCache && _campaignNameCache.has(campaignId)) return _campaignNameCache.get(campaignId);
  if (!_campaignNameCache) _campaignNameCache = new Map();
  try {
    const r = await axios.get(`https://api.instantly.ai/api/v2/campaigns/${campaignId}`, {
      headers: { 'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}` },
      timeout: 4000
    });
    const name = r.data?.name || r.data?.campaign_name || null;
    _campaignNameCache.set(campaignId, name);
    return name;
  } catch (e) {
    _campaignNameCache.set(campaignId, null);
    return null;
  }
}

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
 * GET /api/calendar/sync-meetings
 *   ?from=YYYY-MM-DD   defaults to 7 days ago
 *   ?to=YYYY-MM-DD     defaults to today
 *   ?calendarId=...    defaults to GOOGLE_CALENDAR_ID or 'primary'
 *
 * Returns array of meeting objects shaped for the Sales Funnel tab.
 * Each row carries a stable `eventId` so the frontend can dedupe.
 */
router.get('/sync-meetings', async (req, res) => {
  try {
    const calendarId = req.query.calendarId || process.env.GOOGLE_CALENDAR_ID || 'primary';

    const from = req.query.from
      ? new Date(req.query.from + 'T00:00:00Z')
      : (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })();
    const to = req.query.to
      ? new Date(req.query.to + 'T23:59:59Z')
      : new Date();

    const cal = getCalendar();
    const events = [];
    let pageToken;
    do {
      const r = await cal.events.list({
        calendarId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        pageToken
      });
      events.push(...(r.data.items || []));
      pageToken = r.data.nextPageToken;
    } while (pageToken);

    const meetings = [];
    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      const cls = classifyEvent(ev.summary || '');
      if (!cls) continue;
      const { prospect, email } = pickProspectFromAttendees(ev.attendees || [], cls.company);
      const startISO = (ev.start?.dateTime || ev.start?.date || '').slice(0, 10);
      if (!startISO) continue;

      const isPast = new Date(ev.end?.dateTime || ev.end?.date || ev.start?.dateTime) < new Date();

      meetings.push({
        eventId: ev.id,
        dateBooked: startISO,
        prospect: prospect || cls.company,
        company: cls.company,
        sourceChannel: '',
        sourceAccount: '',
        callType: cls.callType,
        showed: isPast,
        qualified: false,
        secondCall: cls.callType === 'second',
        closed: false,
        retainer: 0,
        prospectEmail: email,
        title: ev.summary,
        htmlLink: ev.htmlLink,
        attendeesCount: (ev.attendees || []).length,
        source: 'calendar-auto'
      });
    }

    // Attribute each meeting to its outbound source by cross-referencing
    // the prospect email against Instantly leads. Best-effort; never blocks.
    if (process.env.INSTANTLY_API_KEY) {
      _campaignNameCache = new Map();
      await Promise.all(meetings.map(async (m) => {
        if (!m.prospectEmail) return;
        const hit = await lookupInstantlyLead(m.prospectEmail);
        if (!hit) return;
        const name = hit.campaignName || await getInstantlyCampaignName(hit.campaignId);
        m.sourceChannel = 'Cold Email';
        m.sourceAccount = 'Instantly — ' + (name || ('Campaign ' + (hit.campaignId || '?')));
      }));
    }

    res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      calendarId,
      eventsScanned: events.length,
      meetingsMatched: meetings.length,
      attributed: meetings.filter(m => m.sourceChannel).length,
      items: meetings
    });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

module.exports = router;

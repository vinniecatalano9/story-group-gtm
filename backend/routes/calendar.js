const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const SECOND_CALL_PATTERNS = [
  /solutions?\s+call/i,
  /proposal/i,
  /pitch(?:\s+(?:call|meeting))?/i,
  /close\s+call/i,
  /follow[- ]up\s+(?:call|meeting)/i
];

const STORY_GROUP_PREFIX = /^story\s*group\s*[&|/-]\s*/i;
const INTERNAL_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'wrstrategies.com'];

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

  // Company = strip "Story Group & " prefix, then strip trailing call-type keyword.
  let company = t.replace(STORY_GROUP_PREFIX, '');
  SECOND_CALL_PATTERNS.forEach(rx => { company = company.replace(rx, ''); });
  company = company.replace(/\s{2,}/g, ' ').replace(/[-–—|/]+\s*$/, '').trim();

  return {
    callType: isSecond ? 'second' : 'discovery',
    company
  };
}

function pickProspectFromAttendees(attendees) {
  if (!Array.isArray(attendees)) return { prospect: '', email: '' };
  const external = attendees.find(a => {
    const email = (a.email || '').toLowerCase();
    if (!email) return false;
    return !INTERNAL_DOMAINS.some(d => email.endsWith('@' + d));
  });
  if (!external) return { prospect: '', email: '' };
  const name = external.displayName || external.email.split('@')[0].replace(/[._]/g, ' ');
  return { prospect: name, email: external.email };
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
      const { prospect, email } = pickProspectFromAttendees(ev.attendees || []);
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

    res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      calendarId,
      eventsScanned: events.length,
      meetingsMatched: meetings.length,
      items: meetings
    });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

module.exports = router;

// Ad lead auto-booking: Google Apps Script web app that runs as
// vincent@storygroup.io, so the event lands on his calendar and Google sends
// the invite (with a Meet link) from him. services/autoBook.js calls it.
//
// The server's service account can only read the calendar, and a service
// account can't invite guests or add Meet without domain-wide delegation,
// which is why this runs as Vincent.
//
// Setup (once, signed in as vincent@storygroup.io):
// 1. script.google.com > New project. Paste this file. Set SECRET to the value
//    of AUTOBOOK_SECRET in the VPS backend .env (never commit the real one).
// 2. Services (+) > Google Calendar API > Add (keeps the identifier "Calendar").
// 3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
//    Authorize when asked.
// 4. Put the web app URL in the VPS .env as AUTOBOOK_SCRIPT_URL, then restart.
// A code change needs Deploy > Manage deployments > Edit > New version (same URL).

const SECRET = 'PASTE_AUTOBOOK_SECRET_HERE';
const CAL = 'primary';

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  if (!req || req.secret !== SECRET) return out({ ok: false, error: 'unauthorized' });
  try {
    if (req.action === 'ping') return out({ ok: true, user: Session.getEffectiveUser().getEmail() });
    if (req.action === 'book') return out(book(req));
    if (req.action === 'cancel') {
      Calendar.Events.remove(CAL, req.event_id, { sendUpdates: 'all' });
      return out({ ok: true });
    }
    return out({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}

function book(req) {
  const start = new Date(req.start);
  const end = new Date(req.end);
  // Last check right before booking: any timed event he hasn't declined.
  const clash = CalendarApp.getDefaultCalendar().getEvents(start, end)
    .filter(ev => !ev.isAllDayEvent() && ev.getMyStatus() !== CalendarApp.GuestStatus.NO);
  if (clash.length) return { ok: false, taken: true, clash: clash.map(ev => ev.getTitle()) };

  const event = {
    summary: req.title,
    description: req.description || '',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: { useDefault: true },
  };
  if (req.guest_email) event.attendees = [{ email: req.guest_email, displayName: req.guest_name || '' }];
  if (req.meet) event.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  const ev = Calendar.Events.insert(event, CAL, { conferenceDataVersion: req.meet ? 1 : 0, sendUpdates: req.guest_email ? 'all' : 'none' });
  return { ok: true, event_id: ev.id, meet_link: ev.hangoutLink || '', html_link: ev.htmlLink };
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

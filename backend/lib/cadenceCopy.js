// lib/cadenceCopy.js — steps and copy for the ad lead cadence.
// Source of truth: story-group-gtm-engine/outreach/AD_LEADS_CADENCE_PLAN.md.
//
// Email 1 and Text 1 are Vincent's approved copy (10/22/2026) and live here.
// Every other step has no copy until Vincent writes it on the dashboard
// (Firestore cadence_copy/{step id}); a step with no copy blocks the lead and
// is never sent. No booking link in any automated message (Vincent).

const SUBJECT = 'Story Group: quick call?';
const AD = '"Become Impossible to Ignore"';

// Tracks. `day` counts from the lead's day 1 (the day Email 1 went out, or the
// day the outcome was set), in the lead's time zone, weekdays only.
const TRACKS = {
  intro: [
    { id: 'email1', channel: 'email', day: 1, label: 'Email 1' },
    { id: 'text1', channel: 'sms', day: 1, afterMinutes: 60, label: 'Text 1' },
    { id: 'text2', channel: 'sms', day: 2, label: 'Text 2' },
    { id: 'email2', channel: 'email', day: 4, label: 'Email 2' },
    { id: 'text3', channel: 'sms', day: 6, label: 'Text 3' },
    { id: 'email3', channel: 'email', day: 9, label: 'Email 3' },
    { id: 'text4', channel: 'sms', day: 14, label: 'Text 4 (breakup)' },
  ],
  // Hit once: talked, no meeting yet. 3 touches, 7 days apart. [CLAUDE'S IDEA: channels email, text, email]
  nurture: [
    { id: 'nurture1', channel: 'email', day: 8, label: 'Nurture 1' },
    { id: 'nurture2', channel: 'sms', day: 15, label: 'Nurture 2' },
    { id: 'nurture3', channel: 'email', day: 22, label: 'Nurture 3' },
  ],
  // Talked yes: booking follow-up, switching channel after 24h with no reply (playbook).
  booking: [
    { id: 'booking1', channel: 'email', day: 2, label: 'Booking follow-up (email)' },
    { id: 'booking2', channel: 'sms', day: 3, label: 'Booking follow-up (text)' },
  ],
  // Meeting yes: reminders at 24h and 1h before the meeting (playbook).
  meeting: [
    { id: 'remind24_email', channel: 'email', beforeMeetingMinutes: 24 * 60, label: '24h reminder (email)' },
    { id: 'remind24_text', channel: 'sms', beforeMeetingMinutes: 24 * 60 - 5, label: '24h reminder (text)' },
    { id: 'remind1_email', channel: 'email', beforeMeetingMinutes: 60, label: '1h reminder (email)' },
    { id: 'remind1_text', channel: 'sms', beforeMeetingMinutes: 55, label: '1h reminder (text)' },
  ],
};

const ALL_STEPS = Object.values(TRACKS).flat();
const stepById = id => ALL_STEPS.find(s => s.id === id);

// Email 1 lines from the form's "biggest frustration" answer. [CLAUDE'S IDEA, approved with Email 1]
function frustrationLine(answer) {
  const a = String(answer || '').toLowerCase();
  if (/not sure where the gap/.test(a)) return "You mentioned you're not sure where the gap is. That's exactly what the first call is for.";
  if (/not enough (people|visibility)|strong work|enough people see/.test(a)) return 'You mentioned the work is strong but not enough people see it. That\'s the most common thing we fix.';
  if (/attention but not authority|not authority/.test(a)) return "You mentioned you're getting attention but not authority. That gap is usually about where you show up, not how much.";
  return '';
}

const isMarketing = role => /marketing/i.test(role || '');

function timesLine({ today_slot, slot_1, slot_2 }) {
  const two = [slot_1, slot_2].filter(Boolean).join(' or ');
  if (today_slot && two) return `Do you have 15 to 30 minutes today? I can give you a call at ${today_slot} ET if you're free. If today doesn't work, how about ${two} ET? Happy to work around your schedule.`;
  if (today_slot) return `Do you have 15 to 30 minutes today? I can give you a call at ${today_slot} ET if you're free. If today doesn't work, happy to work around your schedule.`;
  if (two) return `Do you have 15 to 30 minutes ${two} ET? If ${slot_2 ? 'neither works' : "that doesn't work"}, happy to work around your schedule.`;
  return 'Do you have 15 to 30 minutes this week? Happy to work around your schedule.';
}

/** Email 1 (approved). Returns { subject, text }. */
function email1(lead, times) {
  const first = lead.greet_name || lead.first_name || 'there';
  const mk = isMarketing(lead.role);
  const fr = frustrationLine(lead.frustration);
  const text = [
    `Hey ${first},`,
    '',
    `Thanks for reaching out through our ${AD} ad.${fr ? ` ${fr}` : ''} Would love to hop on a quick call to learn what ${mk ? 'you and your team are' : "you're"} working on and share where we see opportunities to get ${mk ? 'the company' : 'you'} more visibility.`,
    '',
    timesLine(times),
    '',
    'Best,',
    'Vincent',
    'Story Group',
  ].join('\n');
  return { subject: SUBJECT, text };
}

/** Text 1 (approved). Drops the "today" part when there's no slot today. */
function text1(lead, { today_slot, slot_1, slot_2 }) {
  const first = lead.sms_name || lead.first_name || 'there';
  const open = `Hi ${first}, it's Vincent with Story Group. Just sent you an email about the ${AD} ad you responded to.`;
  const two = [slot_1, slot_2].filter(Boolean).join(' or ');
  if (today_slot) return `${open} I can give you a call today at ${today_slot} ET if you're free${two ? `, or ${two} ET works too` : ''}.`;
  // [CLAUDE'S IDEA] wording for the no-today and calendar-full versions.
  if (two) return `${open} I can give you a call ${two} ET if you're free.`;
  return `${open} Happy to find a time that works for you this week.`;
}

/** Fill {first}, {slot_1}... in Vincent's own copy for later steps. */
function fill(template, lead, times = {}) {
  const vars = {
    first: lead.first_name || 'there',
    today_slot: times.today_slot || '', slot_1: times.slot_1 || '', slot_2: times.slot_2 || '',
    times_line: timesLine(times),
    meeting_time: lead.meeting_label || '',
  };
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

module.exports = { SUBJECT, TRACKS, ALL_STEPS, stepById, email1, text1, fill, frustrationLine, timesLine };

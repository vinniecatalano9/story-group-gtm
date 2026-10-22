// lib/cadenceCopy.js — steps and copy for the ad lead cadence.
// Source of truth: story-group-gtm-engine/outreach/AD_LEADS_CADENCE_PLAN.md.
//
// Copy rules (Vincent, 10/22, gtm-advisor reply rules): every message ends in
// one question; times are one day with a morning and an afternoon time; the
// day OR the date, never both; no booking link anywhere.
//
// `approved: true` = Vincent's approved copy (10/22). `approved: false` =
// Claude's draft: the step stays blocked until Vincent approves or rewrites
// it on the dashboard (saved to Firestore cadence_copy/{step id}, which also
// overrides any copy here).
//
// Template variables: {first} {frustration_line} {today} {day} {am} {pm}
// {time} {meeting_day} {meeting_time} {times_question}. Steps whose copy uses
// a time get fresh times planned and held when they're queued.

const SUBJECT = 'Story Group: quick call?';
const AD = '"Become Impossible to Ignore"';

// `day` counts from the lead's day 1 (the day Email 1 went out, or the day the
// outcome was set), in the lead's time zone, weekdays only.
const TRACKS = {
  intro: [
    {
      id: 'email1', channel: 'email', day: 1, label: 'Email 1', approved: true, subject: SUBJECT,
      template: `Hey {first},\n\nThanks for reaching out through our ${AD} ad. {frustration_line} Would love to hop on a quick call to learn what you're working on and share where we see opportunities to get you more visibility.\n\n{times_question}\n\nBest,\nVincent\nStory Group`,
    },
    {
      id: 'text1', channel: 'sms', day: 1, afterMinutes: 60, label: 'Text 1', approved: true, reuseOffer: 'email1',
      template: `Hi {first}, it's Vincent with Story Group. Just sent you an email about the ${AD} ad you responded to. {times_question_text}`,
    },
    { id: 'text2', channel: 'sms', day: 2, label: 'Text 2', approved: true,
      template: 'Hey {first}, not sure if text or email is better for you. {day} at {time} ET is open for a quick call. Does that work?' },
    { id: 'email2', channel: 'email', day: 4, label: 'Email 2', approved: true,
      template: 'Hey {first},\n\nAny thoughts on my last note? Happy to find 15 to 30 minutes that works for you. What does your week look like?\n\nVincent' },
    { id: 'text3', channel: 'sms', day: 6, label: 'Text 3', approved: true,
      template: "Hey {first}, I'm sure this got buried. Does {day} at {time} ET work for a quick call?" },
    { id: 'email3', channel: 'email', day: 9, label: 'Email 3', approved: true,
      template: "Hey {first},\n\nI'm sure this got lost in your inbox. Let's try for this week: does {day} at {am} or {pm} ET work?\n\nVincent" },
    { id: 'text4', channel: 'sms', day: 14, label: 'Text 4 (breakup)', approved: true,
      template: 'Hey {first}, looks like now might not be the right time. Should I close this out, or is getting more visibility still on your list?' },
  ],
  // Hit once: talked, no meeting yet. 3 touches, 7 days apart. [CLAUDE'S DRAFTS, not approved]
  nurture: [
    { id: 'nurture1', channel: 'email', day: 8, label: 'Nurture 1', approved: false,
      template: 'Hey {first},\n\nGood talking last week. Is getting more visibility still on your list? If so, does {day} at {am} or {pm} ET work to pick it back up?\n\nVincent' },
    { id: 'nurture2', channel: 'sms', day: 15, label: 'Nurture 2', approved: false,
      template: "Hey {first}, it's Vincent from Story Group. Still thinking about getting more visibility? {day} at {time} ET is open. Does that work?" },
    { id: 'nurture3', channel: 'email', day: 22, label: 'Nurture 3', approved: false,
      template: 'Hey {first},\n\nCircling back one more time. Should I check back next quarter, or is now still a good time to talk about visibility?\n\nVincent' },
  ],
  // Talked yes: booking follow-up, switching channel after 24h with no reply (playbook). [CLAUDE'S DRAFTS, not approved]
  booking: [
    { id: 'booking1', channel: 'email', day: 2, label: 'Booking follow-up (email)', approved: false,
      template: "Hey {first},\n\nGreat talking. Let's get it on the calendar: does {day} at {am} or {pm} ET work?\n\nVincent" },
    { id: 'booking2', channel: 'sms', day: 3, label: 'Booking follow-up (text)', approved: false,
      template: "Hey {first}, it's Vincent from Story Group. Want to lock in our call. Does {day} at {time} ET work?" },
  ],
  // Meeting yes: booked.
  meeting: [
    { id: 'meet_confirm', channel: 'sms', immediate: true, label: 'Booked: confirm text', approved: true,
      template: "Hey {first}, it's Vincent from Story Group. See you {meeting_day}." },
    { id: 'meet_question', channel: 'sms', afterMinutes: 3, label: 'Booked: question text', approved: true,
      template: 'Curious, what do you have in place now to get more visibility?' },
    // Reminders: [CLAUDE'S DRAFTS, not approved]
    { id: 'remind24_email', channel: 'email', beforeMeetingMinutes: 24 * 60, label: '24h reminder (email)', approved: false,
      template: 'Hey {first},\n\nLooking forward to our call {meeting_day} at {meeting_time} ET. Still good for that time?\n\nVincent' },
    { id: 'remind24_text', channel: 'sms', beforeMeetingMinutes: 24 * 60 - 5, label: '24h reminder (text)', approved: false,
      template: "Hey {first}, it's Vincent from Story Group. Still good for {meeting_day} at {meeting_time} ET?" },
    { id: 'remind1_email', channel: 'email', beforeMeetingMinutes: 60, label: '1h reminder (email)', approved: false,
      template: 'Hey {first},\n\nTalk in an hour, at {meeting_time} ET. Still good?\n\nVincent' },
    { id: 'remind1_text', channel: 'sms', beforeMeetingMinutes: 55, label: '1h reminder (text)', approved: false,
      template: 'Hey {first}, talk in an hour at {meeting_time} ET. Still good?' },
    // No call 15 minutes after the start (or Vincent marks a no-show).
    { id: 'noshow', channel: 'sms', afterMeetingMinutes: 15, label: 'No-show text', approved: true,
      template: "Looks like we missed each other, happens. I've got {noshow_times}. Which works?" },
  ],
};

const ALL_STEPS = Object.values(TRACKS).flat();
const stepById = id => ALL_STEPS.find(s => s.id === id);
const usesTimes = tpl => /\{(today|day|am|pm|time|times_question|times_question_text|noshow_times)\}/.test(tpl);

// Email 1 lines from the form's "biggest frustration" answer. [CLAUDE'S IDEA, approved with Email 1]
function frustrationLine(answer) {
  const a = String(answer || '').toLowerCase();
  if (/not sure where the gap/.test(a)) return "You mentioned you're not sure where the gap is. That's exactly what the first call is for.";
  if (/not enough (people|visibility)|strong work|enough people see/.test(a)) return 'You mentioned the work is strong but not enough people see it. That\'s the most common thing we fix.';
  if (/attention but not authority|not authority/.test(a)) return "You mentioned you're getting attention but not authority. That gap is usually about where you show up, not how much.";
  return '';
}

const amPm = t => [t.am, t.pm].filter(Boolean).join(' or ');

// Email 1's question. Approved: with and without a today slot. [CLAUDE'S IDEA] calendar-full fallback.
function timesQuestion(t) {
  if (t.today && t.day) return `Could I give you a call today at ${t.today} ET, or does ${t.day} at ${amPm(t)} ET work better?`;
  if (t.day) return `Does ${t.day} at ${amPm(t)} ET work for a quick call?`;
  if (t.today) return `Could I give you a call today at ${t.today} ET?`;
  return 'What does your week look like for a quick call?';
}

// Text 1's question. Approved with a today slot; [CLAUDE'S IDEA] the others, in the same words.
function timesQuestionText(t) {
  if (t.today && t.day) return `Could I call you today at ${t.today} ET, or does ${t.day} at ${amPm(t)} ET work better?`;
  if (t.day) return `Does ${t.day} at ${amPm(t)} ET work for a quick call?`;
  if (t.today) return `Could I call you today at ${t.today} ET?`;
  return 'What does your week look like for a quick call?';
}

// No-show: two options, "today at 3:00pm or Friday at 10:00am".
function noshowTimes(t) {
  const opts = [];
  if (t.today) opts.push(`today at ${t.today}`);
  if (t.day && t.am) opts.push(`${t.day} at ${t.am}`);
  if (t.day && t.pm && opts.length < 2) opts.push(`${t.day} at ${t.pm}`);
  return opts.length ? `${opts.slice(0, 2).join(' or ')} ET` : null;
}

/**
 * Fill a template. `times` comes from cadenceSlots.labels(); `meeting` is
 * { day, time } for the meeting track. Returns null when the copy needs a time
 * and there's none to offer (the step blocks rather than send a broken line).
 */
function render(template, lead, times = {}, meeting = {}) {
  const t = times || {};
  const vars = {
    first: lead.greet_name || lead.first_name || 'there',
    frustration_line: frustrationLine(lead.frustration),
    today: t.today, day: t.day, am: t.am, pm: t.pm, time: t.time,
    times_question: timesQuestion(t),
    times_question_text: timesQuestionText(t),
    noshow_times: (t.today || t.day) ? noshowTimes(t) : null,
    meeting_day: meeting.day, meeting_time: meeting.time,
  };
  let missing = false;
  const out = String(template).replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) return m;
    if (vars[k] == null || vars[k] === '') { if (k !== 'frustration_line') missing = true; return ''; }
    return vars[k];
  });
  if (missing) return null;
  return out.replace(/ {2,}/g, ' ').replace(/ \./g, '.').trim();
}

// Texts go to the lead's phone; the greeting name override is for email only.
const renderFor = (step, template, lead, times, meeting) =>
  render(template, step.channel === 'sms' ? { ...lead, greet_name: lead.sms_name || '' } : lead, times, meeting);

module.exports = { SUBJECT, TRACKS, ALL_STEPS, stepById, usesTimes, render: renderFor, frustrationLine };

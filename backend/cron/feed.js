// cron/feed.js — facts for Vincent's one GTM feed on Telegram (Work Bot).
//
// Replaces reading four reports (Slack morning brief, reminders email, weekly
// insights, pre-call email) with one Telegram feed. This file only gathers
// numbers and lists, no AI, so it can't fail on a model call:
//   digest  — weekday mornings: replies waiting, follow-ups due, today's calls,
//             yesterday's calls, Nutshell tasks + new leads, LinkedIn + email.
//   weekly  — Mondays: 7-day vs prior 7-day rates, reply mix, calls held and
//             booked, the latest insights run.
// Root cron (/usr/local/bin/gtm-feed on the VPS) runs scripts/gtm-feed.js,
// drops the JSON in Work Bot's ~/gtm-feed and nudges the bot, which adds the
// advisor take, makes the no-reply Gmail drafts and sends ONE message.
// `text` is a plain rendering used only when Work Bot isn't running.
//
// Items show once: the digest stamps its own feed_* markers (separate from
// the reminders email's markers, so the two never hide items from each other).

const axios = require('axios');
const { db, transcripts } = require('../services/db');
const { getTodaysEvents, getEventsWindow } = require('../services/calendar');
const nutshell = require('../services/nutshell');
const { getBoard, classMix7d, WINNABLE } = require('./brief');
const { findNudgeCandidates, findMetButStalled, findInterestedNotBooked } = require('./reminders');

const HR_BASE = 'https://api.heyreach.io/api/public';
const INST_BASE = 'https://api.instantly.ai/api/v2';
const CT = 'America/Chicago';
const TEAM_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'fireflies.ai', 'group.calendar.google.com', 'resource.calendar.google.com'];
const INTERNAL_TITLES = /l10|leadership|standup|team meeting|one on one|1:1|internal|sameer|web team|invoicing|sync up/i;
const VINCENT_NUTSHELL_ID = 3;
const STATE = () => db.collection('feed_state').doc('digest');

const dayCT = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: CT }).format(d);
const timeCT = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' });
const isExternal = (email) => email && email.includes('@') && !TEAM_DOMAINS.includes(email.split('@')[1]) && !/vincent|vinnie/.test(email);
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// Midnight Central for a YYYY-MM-DD day (CDT is UTC-5, CST is UTC-6).
const ctOffsetHours = () => (/CST/.test(new Date().toLocaleString('en-US', { timeZone: CT, timeZoneName: 'short' })) ? 6 : 5);
const ctMidnight = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + ctOffsetHours() * 3600e3);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

async function safe(label, fn, fallback = null) {
  try { return await fn(); } catch (e) { console.error(`[feed] ${label} failed:`, e.message); return fallback; }
}

// ── LinkedIn (HeyReach) ──────────────────────────────────────────────────────
function hrHeaders() {
  const k = process.env.HEYREACH_API_KEY;
  if (!k) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': k, 'Content-Type': 'application/json' };
}

async function hrIds() {
  const a = await axios.post(`${HR_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: hrHeaders() });
  const c = await axios.post(`${HR_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: hrHeaders() });
  return { accounts: a.data?.items || [], campaignIds: (c.data?.items || []).map(x => x.id) };
}

async function hrStats(accountIds, campaignIds, start, end) {
  if (!accountIds.length || !campaignIds.length) return null;
  const r = await axios.post(`${HR_BASE}/stats/GetOverallStats`,
    { accountIds, campaignIds, startDate: start.toISOString(), endDate: end.toISOString() },
    { headers: hrHeaders() });
  const agg = { connectionsSent: 0, connectionsAccepted: 0, messagesSent: 0, totalMessageReplies: 0, inmailMessagesSent: 0, totalInmailReplies: 0, autoTaggedInterested: 0 };
  for (const d of Object.values(r.data?.byDayStats || {})) for (const k of Object.keys(agg)) agg[k] += (d[k] || 0);
  const replies = agg.totalMessageReplies + agg.totalInmailReplies;
  return {
    invites: agg.connectionsSent, accepted: agg.connectionsAccepted, acceptance_pct: pct(agg.connectionsAccepted, agg.connectionsSent),
    messages: agg.messagesSent, inmails: agg.inmailMessagesSent, replies, reply_pct_per_message: pct(replies, agg.messagesSent + agg.inmailMessagesSent),
    interested_tags: agg.autoTaggedInterested,
  };
}

const daysAgo = (n) => new Date(Date.now() - n * 86400e3);

// ── Email (Instantly) ────────────────────────────────────────────────────────
async function instantly(startDay, endDay) {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) return null;
  const r = await axios.get(`${INST_BASE}/campaigns/analytics/overview`, {
    headers: { Authorization: `Bearer ${key}` }, params: { start_date: startDay, end_date: endDay },
  });
  const d = r.data || {};
  const sent = d.emails_sent_count || 0;
  const replies = d.reply_count_unique || d.reply_count || 0;
  return {
    sent, new_leads_contacted: d.new_leads_contacted_count || 0, replies, reply_pct: pct(replies, sent),
    bounced: d.bounced_count || 0, bounce_pct: pct(d.bounced_count || 0, sent),
    interested: d.total_interested || 0, opportunities: d.total_opportunities || 0, meetings_booked: d.total_meeting_booked || 0,
  };
}

// ── Nutshell ─────────────────────────────────────────────────────────────────
async function nutshellTasksDue() {
  const res = await nutshell.call('findTasks', { query: { assignee: { entityType: 'Users', id: VINCENT_NUTSHELL_ID } }, limit: 100 });
  const endToday = new Date(ctMidnight(dayCT()).getTime() + 86400e3 - 1);
  return (res || [])
    .filter(t => !t.finishedTime && !t.isFinished && t.status !== 1)
    .filter(t => t.dueTime && new Date(t.dueTime) <= endToday)
    .map(t => ({ id: t.id, title: clip(t.title || t.name, 120), due: String(t.dueTime).slice(0, 10), lead: t.entity?.name || t.entity?.description || null }))
    .slice(0, 15);
}

async function nutshellNewLeads(lastId) {
  const res = await nutshell.call('findLeads', { query: { status: 0 }, orderBy: 'id', orderDirection: 'DESC', limit: 25, stubResponses: true });
  const leads = (res || []).map(l => ({ id: l.id, what: clip(l.description || l.name, 100), contact: l.primaryContactName || null, company: l.primaryAccountName || null }));
  const maxId = leads.reduce((m, l) => Math.max(m, l.id || 0), lastId || 0);
  // First run has no baseline: record it, report nothing.
  return { maxId, leads: lastId ? leads.filter(l => l.id > lastId) : [] };
}

// ── Calls ────────────────────────────────────────────────────────────────────
async function todaysCalls() {
  const events = await getTodaysEvents();
  const ledger = await safe('pre-call ledger', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const s = await db.collection('precall_briefs').doc(day).get();
    return new Set(s.exists ? (s.data().event_ids || []) : []);
  }, new Set());
  return events.map(e => {
    const ext = e.attendees.filter(a => isExternal(a.email));
    const prospect = ext.length > 0 && !INTERNAL_TITLES.test(e.title);
    return {
      time_ct: /T/.test(e.start) ? timeCT(e.start) : 'all day', title: clip(e.title, 90),
      kind: prospect ? 'prospect' : (ext.length ? 'external' : 'internal'),
      with: ext.slice(0, 3).map(a => a.name ? `${a.name} <${a.email}>` : a.email),
      brief_sent: prospect ? ledger.has(e.id) : undefined,
    };
  });
}

async function callsBetween(start, end) {
  const snap = await transcripts.where('date', '>=', start.toISOString()).where('date', '<', end.toISOString()).orderBy('date', 'desc').limit(50).get();
  return snap.docs.map(d => d.data()).map(t => ({
    title: clip(t.title, 90), date: (t.date || '').slice(0, 10),
    minutes: t.duration ? Math.round(t.duration > 300 ? t.duration / 60 : t.duration) : null,
    external: (t.participants || []).map(p => String(p).toLowerCase().trim()).filter(isExternal).slice(0, 3),
  }));
}

// ── Digest ───────────────────────────────────────────────────────────────────
async function digestFacts() {
  const today = dayCT();
  const yesterday = dayCT(daysAgo(1));
  const startToday = ctMidnight(today);
  const state = await safe('feed state', async () => (await STATE().get()).data() || {}, {});

  const hr = await safe('HeyReach ids', hrIds, null);
  const [li1, li7, em1, em7, board, nudges, stalled, notBooked, calls, yCalls, tasks, newLeads] = await Promise.all([
    hr ? safe('HeyReach 1d', () => hrStats(hr.accounts.map(a => a.id), hr.campaignIds, daysAgo(1), new Date())) : null,
    hr ? safe('HeyReach 7d', () => hrStats(hr.accounts.map(a => a.id), hr.campaignIds, daysAgo(7), new Date())) : null,
    safe('Instantly 1d', () => instantly(yesterday, yesterday)),
    safe('Instantly 7d', () => instantly(dayCT(daysAgo(7)), yesterday)),
    safe('board', getBoard, []),
    safe('nudges', () => findNudgeCandidates({ marker: 'feed_nudge_shown_at' }), []),
    safe('stalled', () => findMetButStalled({ marker: 'feed_stalled_shown_at' }), []),
    safe('not booked', () => findInterestedNotBooked({ marker: 'feed_notbooked_shown_at' }), []),
    safe('today calls', todaysCalls, []),
    safe('yesterday calls', () => callsBetween(new Date(startToday.getTime() - 86400e3), startToday), []),
    nutshell.isConfigured() ? safe('Nutshell tasks', nutshellTasksDue, null) : null,
    nutshell.isConfigured() ? safe('Nutshell leads', () => nutshellNewLeads(state.last_lead_id), null) : null,
  ]);

  const facts = {
    kind: 'digest', date: today, weekday: new Date().toLocaleDateString('en-US', { timeZone: CT, weekday: 'long' }),
    replies_waiting: board.slice(0, 12).map(b => ({ name: b.name, company: clip(b.company, 50), email: b.email || null, channel: b.channel === 'heyreach' ? 'LinkedIn' : 'Email', type: b.classification, hot: b.hot, draft_ready: b.hasDraft, said: clip(b.reply, 160) })),
    replies_waiting_total: board.length,
    // Older than 3 weeks is a dead thread, not a nudge.
    followups_quiet: nudges.filter(n => n.ageDays <= 21).map(n => ({ path: n.ref.path, to: n.d.to, call: clip(n.t.title, 80), call_date: (n.t.date || '').slice(0, 10), followup_subject: clip(n.d.subject, 100), days_since_followup: n.ageDays })),
    met_but_stalled: stalled.map(s => ({ path: s.ref.path, email: s.email, call: clip(s.title, 80), days_since_call: s.daysAgo, last_contact: s.lastContactWhat, whose_move: s.lastContactWhat === 'we emailed' ? 'theirs' : 'ours', action_items: clip(s.actionItems, 180) || null }))
      .sort((a, b) => (a.whose_move === 'ours' ? 0 : 1) - (b.whose_move === 'ours' ? 0 : 1) || a.days_since_call - b.days_since_call),
    interested_not_booked: notBooked.map(r => ({ path: `replies/${r.id}`, email: r.email, name: r.full_name || null, company: clip(r.company_name, 50) || null, replied: r.created_at?.toDate ? dayCT(r.created_at.toDate()) : null })),
    calls_today: calls,
    calls_yesterday: yCalls,
    nutshell_tasks_due: tasks,
    nutshell_new_leads: newLeads ? newLeads.leads : null,
    linkedin_24h: li1, linkedin_7d: li7,
    email_yesterday: em1, email_7d: em7,
    sources_down: [
      !hr && 'HeyReach', !em7 && 'Instantly', tasks === null && 'Nutshell tasks', newLeads === null && 'Nutshell leads',
    ].filter(Boolean),
    _mark: { last_lead_id: newLeads ? newLeads.maxId : state.last_lead_id || null },
  };

  const covered = new Set();
  for (const b of board) if (b.email) covered.add(b.email.toLowerCase());
  for (const n of facts.followups_quiet) String(n.to || '').split(/[,;\s]+/).filter(x => x.includes('@')).forEach(x => covered.add(x.toLowerCase()));
  for (const s of facts.met_but_stalled) covered.add(s.email);
  for (const r of facts.interested_not_booked) covered.add(String(r.email).toLowerCase());
  for (const c of calls) for (const w of c.with) covered.add((w.match(/<(.+)>/)?.[1] || w).toLowerCase());
  facts.covered_emails = [...covered];

  facts.text = digestText(facts);
  return facts;
}

/** Plain fallback when Work Bot can't write the message. Empty sections are left out. */
function digestText(f) {
  const L = [`☀️ GTM digest, ${f.weekday}`];
  const hot = f.replies_waiting.filter(r => r.hot);
  if (f.replies_waiting_total) {
    L.push('', `Replies waiting: ${f.replies_waiting_total}${hot.length ? ` (${hot.length} interested)` : ''}`);
    for (const r of f.replies_waiting.slice(0, 5)) L.push(`• ${r.name}${r.company ? `, ${r.company}` : ''} (${r.channel}, ${r.type})${r.draft_ready ? ', draft ready' : ''}`);
  }
  const ours = f.met_but_stalled.filter(s => s.whose_move === 'ours');
  if (f.followups_quiet.length || f.met_but_stalled.length || f.interested_not_booked.length) {
    L.push('', 'Follow-ups');
    for (const n of f.followups_quiet.slice(0, 4)) L.push(`• ${n.to}: no reply ${n.days_since_followup} days after the follow-up on "${n.call}"`);
    if (f.met_but_stalled.length) L.push(`• ${f.met_but_stalled.length} met but nothing booked since${ours.length ? ` (${ours.length} where we owe the next move)` : ''}`);
    if (f.interested_not_booked.length) L.push(`• ${f.interested_not_booked.length} said interested but never booked: ${f.interested_not_booked.slice(0, 4).map(r => r.name || r.email).join(', ')}`);
  }
  const prospects = f.calls_today.filter(c => c.kind !== 'internal');
  if (prospects.length) {
    L.push('', 'Today');
    for (const c of prospects) L.push(`• ${c.time_ct} ${c.title}${c.brief_sent ? ' (brief sent)' : ''}`);
  }
  const yExt = f.calls_yesterday.filter(c => c.external.length);
  if (yExt.length) L.push('', `Yesterday's calls: ${yExt.map(c => c.title).join('; ')}`);
  if (f.nutshell_tasks_due && f.nutshell_tasks_due.length) {
    L.push('', 'Nutshell tasks due');
    for (const t of f.nutshell_tasks_due.slice(0, 5)) L.push(`• ${t.title} (${t.due})`);
  }
  if (f.nutshell_new_leads && f.nutshell_new_leads.length) L.push('', `New Nutshell leads: ${f.nutshell_new_leads.map(l => l.what).join('; ')}`);
  const li = f.linkedin_24h;
  if (li && (li.invites || li.messages || li.replies)) L.push('', `LinkedIn, last 24h: ${li.invites} invites, ${li.accepted} accepted, ${li.replies} replies`);
  const em = f.email_yesterday;
  if (em && em.sent) L.push(`Email yesterday: ${em.sent} sent, ${em.replies} replies, ${em.bounced} bounced`);
  if (f.sources_down.length) L.push('', `Couldn't reach: ${f.sources_down.join(', ')}`);
  if (L.length === 1) L.push('Quiet day. Nothing waiting on you.');
  return L.join('\n');
}

// ── Weekly ───────────────────────────────────────────────────────────────────
async function weeklyFacts() {
  const today = dayCT();
  const hr = await safe('HeyReach ids', hrIds, null);
  const ids = hr ? hr.accounts.map(a => a.id) : [];
  const [liThis, liPrior, emThis, emPrior, mix, held, upcoming, insights] = await Promise.all([
    hr ? safe('HeyReach this week', () => hrStats(ids, hr.campaignIds, daysAgo(7), new Date())) : null,
    hr ? safe('HeyReach prior week', () => hrStats(ids, hr.campaignIds, daysAgo(14), daysAgo(7))) : null,
    safe('Instantly this week', () => instantly(dayCT(daysAgo(7)), dayCT(daysAgo(1)))),
    safe('Instantly prior week', () => instantly(dayCT(daysAgo(14)), dayCT(daysAgo(8)))),
    safe('reply mix', classMix7d, {}),
    safe('calls held', () => callsBetween(daysAgo(7), new Date()), []),
    safe('calls booked', async () => (await getEventsWindow({ daysBack: 0, daysAhead: 7 }))
      .filter(e => e.attendees.some(isExternal) && !INTERNAL_TITLES.test(e.title))
      .map(e => ({ when: `${dayCT(new Date(e.start))} ${/T/.test(e.start) ? timeCT(e.start) : ''}`.trim(), title: clip(e.title, 80) })), []),
    safe('insights', async () => {
      const s = await db.collection('insights').orderBy('created_at', 'desc').limit(1).get();
      if (s.empty) return null;
      const d = s.docs[0].data();
      return { date: d.date, noticing: d.noticing, icp_shift: d.icp?.shift, converting: d.icp?.converting, dead: d.icp?.dead, objections: d.objections, chase: d.chase };
    }),
  ]);

  // Per-sender LinkedIn (acceptance by profile is where the weak senders show).
  const senders = [];
  if (hr) {
    for (const a of hr.accounts.slice(0, 8)) {
      const s = await safe(`HeyReach sender ${a.id}`, () => hrStats([a.id], hr.campaignIds, daysAgo(7), new Date()));
      if (s && (s.invites || s.messages)) senders.push({ sender: `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.emailAddress || String(a.id), ...s });
    }
  }

  const positives = WINNABLE.reduce((n, c) => n + (mix[c] || 0), 0);
  // Fireflies logs no-shows and re-joins as their own short calls: under 10 min
  // doesn't count as held, and one person counts once.
  const prospectCalls = held.filter(c => c.external.length && !INTERNAL_TITLES.test(c.title));
  const heldPeople = new Set(prospectCalls.filter(c => (c.minutes || 0) >= 10).map(c => c.external[0]));
  const facts = {
    kind: 'weekly', date: today, window: `${dayCT(daysAgo(7))} to ${today}`,
    linkedin: { this_week: liThis, prior_week: liPrior, by_sender: senders },
    email: { this_week: emThis, prior_week: emPrior },
    replies_7d: { by_type: mix, positives_and_questions: positives, interested: mix.interested || 0 },
    prospect_calls_7d: prospectCalls.map(c => ({ ...c, short: (c.minutes || 0) < 10 })),
    calls_booked_next_7d: upcoming,
    funnel_7d: {
      positive_or_question_replies: positives,
      prospects_met_10min_plus: heldPeople.size,
      prospect_calls_booked_next_7d: upcoming.length,
      note: 'Different people sit in each count, so compare the trend week to week, not as an exact positive to meeting rate.',
    },
    insights_latest: insights && insights.date && (Date.now() - new Date(insights.date).getTime()) < 4 * 86400e3 ? insights : null,
    sources_down: [!hr && 'HeyReach', !emThis && 'Instantly'].filter(Boolean),
  };
  facts.text = weeklyText(facts);
  return facts;
}

function weeklyText(f) {
  const L = [`📊 GTM week, ${f.window}`];
  const li = f.linkedin.this_week, lp = f.linkedin.prior_week;
  if (li && (li.invites || li.messages)) L.push(`LinkedIn: ${li.invites} invites, ${li.acceptance_pct ?? 0}% accepted (prior ${lp?.acceptance_pct ?? 'n/a'}%), ${li.replies} replies, ${li.reply_pct_per_message ?? 0}% per message`);
  const em = f.email.this_week;
  if (em && em.sent) L.push(`Email: ${em.sent} sent, ${em.reply_pct}% reply, ${em.bounce_pct}% bounce, ${em.interested} interested`);
  if (f.replies_7d.positives_and_questions) L.push(`Replies worth working: ${f.replies_7d.positives_and_questions} (${f.replies_7d.interested} interested)`);
  if (f.funnel_7d.prospects_met_10min_plus) L.push(`Prospects met (10+ min): ${f.funnel_7d.prospects_met_10min_plus}`);
  if (f.calls_booked_next_7d.length) L.push(`Booked next 7 days: ${f.calls_booked_next_7d.length}`);
  if (L.length === 1) L.push('No outbound activity this week.');
  return L.join('\n');
}

/** After a digest went out: stamp the shown items so tomorrow only shows new ones. */
async function markShown(facts) {
  const at = new Date().toISOString();
  const writes = [
    ...facts.followups_quiet.map(n => [n.path, { feed_nudge_shown_at: at }]),
    ...facts.met_but_stalled.map(s => [s.path, { feed_stalled_shown_at: at }]),
    ...facts.interested_not_booked.map(r => [r.path, { feed_notbooked_shown_at: at }]),
  ];
  for (const [p, data] of writes) await db.doc(p).set(data, { merge: true });
  if (facts._mark?.last_lead_id) await STATE().set({ last_lead_id: facts._mark.last_lead_id, last_digest: at }, { merge: true });
  return writes.length;
}

module.exports = { digestFacts, weeklyFacts, markShown };

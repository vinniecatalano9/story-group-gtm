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
//
// Vincent's own items only (10/21: "i only care bout my stuff"). Calls count
// when he was on them, met-but-stalled only when Fireflies gave him a next
// step, Nutshell only when he's the assignee. Story Group outbound all sends
// as Aaron (his HeyReach sender, aaron@ in Instantly), so those numbers and
// replies are the team's: TEAM_OUTBOUND decides whether they show at all.

const axios = require('axios');
const { db, transcripts } = require('../services/db');
const { getTodaysEvents, getEventsWindow } = require('../services/calendar');
const nutshell = require('../services/nutshell');
const fireflies = require('../services/fireflies');
const { getBoard, classMix7d, WINNABLE } = require('./brief');
const { findNudgeCandidates, findMetButStalled, findInterestedNotBooked } = require('./reminders');

const HR_BASE = 'https://api.heyreach.io/api/public';
const INST_BASE = 'https://api.instantly.ai/api/v2';
const CT = 'America/Chicago';
const TEAM_DOMAINS = ['storygroup.io', 'winningrepublicans.com', 'fireflies.ai', 'group.calendar.google.com', 'resource.calendar.google.com'];
const INTERNAL_TITLES = /l10|leadership|standup|team meeting|one on one|1:1|internal|sameer|web team|invoicing|sync up/i;
// Board meetings and community groups have many outside people but aren't deals.
const GROUP_TITLES = /board meeting|bible study|strategy meeting|webinar|town hall|mixer/i;
const isGroupCall = (title, externalCount) => externalCount > 3 || GROUP_TITLES.test(title || '') || INTERNAL_TITLES.test(title || '');
const VINCENT_NUTSHELL_ID = 3;
const VINCENT_EMAILS = ['vincent@storygroup.io', 'vincent@winningrepublicans.com', 'vinnie.catalano3@gmail.com'];
const isVincent = (email) => VINCENT_EMAILS.includes(String(email || '').toLowerCase().trim());
const VINCENT_NAME = /^(vincent|vinnie)\b/i;
// Teammates who show up as action item owners in Fireflies.
const TEAMMATE_NAME = /^(mckenna|aaron|lydia|michelle|annette|sydney|gabriela)\b/i;
const TEAM_OUTBOUND = false;
const STATE = () => db.collection('feed_state').doc('digest');

const dayCT = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: CT }).format(d);
const timeCT = (d) => new Date(d).toLocaleTimeString('en-US', { timeZone: CT, hour: 'numeric', minute: '2-digit' });
const isExternal = (email) => email && email.includes('@') && !TEAM_DOMAINS.includes(email.split('@')[1]) && !/vincent|vinnie/.test(email);
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// Placeholder text ("-", "Lead–1182", a bare payment code like "- LTKZ2QZQ") isn't a name.
const realText = (s, n) => {
  const v = clip(s, n).replace(/^[-–·\s]+/, '');
  return /[a-z]{3}/.test(v) && !/^Lead[–-]\d+$/.test(v) ? v : null;
};
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
  const maxId = (res || []).reduce((m, l) => Math.max(m, l.id || 0), lastId || 0);
  // First run has no baseline: record it, report nothing.
  const fresh = lastId ? (res || []).filter(l => l.id > lastId).slice(0, 10) : [];
  // Stubs carry no assignee, so read each new lead in full and keep Vincent's.
  const full = await Promise.all(fresh.map(l => safe(`Nutshell lead ${l.id}`, () => nutshell.call('getLead', { leadId: l.id }))));
  const leads = full.filter(l => l && l.assignee?.id === VINCENT_NUTSHELL_ID).map(l => ({
    id: l.id,
    what: realText(l.description, 100),
    contact: (l.contacts || [])[0]?.name || null,
    company: l.primaryAccount?.name || null,
    tags: (l.tags || []).slice(0, 4),
  }));
  return { maxId, leads, others: full.filter(l => l && l.assignee?.id !== VINCENT_NUTSHELL_ID).length };
}

// ── Calls ────────────────────────────────────────────────────────────────────
async function todaysCalls() {
  const events = await getTodaysEvents();
  const ledger = await safe('pre-call ledger', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const s = await db.collection('precall_briefs').doc(day).get();
    return new Set(s.exists ? (s.data().event_ids || []) : []);
  }, new Set());
  // Blocks with nobody else on them ("-", the dentist) aren't calls.
  return events.filter(e => e.attendees.some(a => a.email && !isVincent(a.email))).map(e => {
    const ext = e.attendees.filter(a => isExternal(a.email));
    const prospect = ext.length > 0 && !INTERNAL_TITLES.test(e.title);
    const withList = ext.slice(0, 3).map(a => a.name ? `${a.name} <${a.email}>` : a.email);
    return {
      time_ct: /T/.test(e.start) ? timeCT(e.start) : 'all day',
      title: realText(e.title, 90) || ext.map(a => a.name || a.email).slice(0, 2).join(', ') || 'Untitled',
      kind: prospect ? 'prospect' : (ext.length ? 'external' : 'internal'),
      with: withList,
      brief_sent: prospect ? ledger.has(e.id) : undefined,
    };
  });
}

const externals = (t) => (t.participants || []).map(p => String(p).toLowerCase().trim()).filter(isExternal);
// Each teammate's notetaker makes its own copy of a call (start times can differ
// by a few minutes): same day, same outside people.
const meetingKey = (t) => `${t.date ? dayCT(new Date(t.date)) : ''}|${externals(t).sort().join(',') || t.title}`;

/**
 * Fireflies leaves a copy's own owner out of `participants`, so whose
 * notetaker recorded it (and who spoke) comes from Fireflies. Read once per
 * transcript and cached on the doc as ff_owner / ff_speakers.
 */
async function withOwners(docs) {
  const need = docs.filter(t => t.ff_owner === undefined);
  const query = ids => `query { ${ids.map((id, j) => `t${j}: transcript(id: ${JSON.stringify(id)}) { user { email } speakers { name } }`).join(' ')} }`;
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    let data;
    try { data = await fireflies.graphql(query(chunk.map(t => t.id))); } catch (e) {
      if (/^Fireflies API/.test(e.message)) throw e;   // API down: don't retry one by one
      data = {};                                        // one bad id fails the batch, so ask singly
      for (const [j, t] of chunk.entries()) data[`t${j}`] = await fireflies.graphql(query([t.id])).then(d => d.t0).catch(() => null);
    }
    for (const [j, t] of chunk.entries()) {
      const r = data[`t${j}`];
      if (!r) continue;
      t.ff_owner = r.user?.email || null;
      t.ff_speakers = (r.speakers || []).map(s => s.name).filter(Boolean);
      await transcripts.doc(t.id).set({ ff_owner: t.ff_owner, ff_speakers: t.ff_speakers }, { merge: true });
    }
  }
}

/** Vincent was on a call: invited or his notetaker, and he spoke if Fireflies heard anyone. */
function vincentOn(copies) {
  const invited = copies.some(c => (c.participants || []).some(isVincent) || isVincent(c.ff_owner));
  // His notetaker joins everything on his calendar, so speakers settle whether he was there.
  const speakers = copies.flatMap(c => c.ff_speakers || []);
  return invited && (!speakers.length || speakers.some(n => VINCENT_NAME.test(n)));
}

/** Fireflies action items come as "**Name**" headers over that person's items. */
function actionOwners(text) {
  const byOwner = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^\s*\*\*(.+?)\*\*/);
    if (h) { cur = h[1].trim(); byOwner[cur] = byOwner[cur] || []; continue; }
    const item = line.trim().replace(/\s*\(\d+:\d+\)$/, '');
    if (cur && item && !byOwner[cur].includes(item)) byOwner[cur].push(item);
  }
  return byOwner;
}

/** Transcripts in a window, copies grouped per call. Fireflies failing falls back to participants. */
async function meetingsBetween(start, end) {
  const snap = await transcripts.where('date', '>=', start.toISOString()).where('date', '<', end.toISOString()).orderBy('date', 'desc').limit(300).get();
  const docs = snap.docs.map(d => ({ id: d.id, path: d.ref.path, ...d.data() }));
  const groups = new Map();
  for (const t of docs) groups.set(meetingKey(t), [...(groups.get(meetingKey(t)) || []), t]);
  return { docs, groups };
}

async function callsBetween(start, end) {
  const { groups } = await meetingsBetween(start, end);
  const meetings = [...groups.values()];
  await safe('Fireflies call owners', () => withOwners(meetings.flat()));
  return meetings.filter(vincentOn).map(copies => {
    const t = copies[0];
    const ext = externals(t);
    const minutes = Math.max(0, ...copies.map(c => c.duration ? Math.round(c.duration > 300 ? c.duration / 60 : c.duration) : 0));
    return {
      title: realText(t.title, 90) || ext.slice(0, 2).join(', ') || 'Untitled', date: (t.date || '').slice(0, 10),
      external_count: ext.length, minutes: minutes || null, external: ext.slice(0, 3),
    };
  });
}

// ── Digest ───────────────────────────────────────────────────────────────────
/**
 * Follow-up items that are Vincent's. Each notetaker's copy of a call has its
 * own action items and its own shown marker, so all copies are read together:
 * he was on the call, no copy was shown yet, and Fireflies gave him a next
 * step (or named no teammate at all).
 */
async function vincentsFollowups(stalled, nudges) {
  const { docs, groups } = await meetingsBetween(daysAgo(45), new Date());
  const copiesOf = (ref, t) => {
    const doc = docs.find(d => d.path === ref.path) || { id: ref.id, path: ref.path, ...t };
    return groups.get(meetingKey(doc)) || [doc];
  };
  const st = stalled.map(s => ({ s, copies: copiesOf(s.ref, { date: s.date, title: s.title, participants: [s.email] }) }));
  const nu = nudges.map(n => ({ n, copies: copiesOf(n.ref, n.t) }));
  const ok = await safe('Fireflies call owners', async () => { await withOwners([...new Set([...st, ...nu].flatMap(x => x.copies))]); return true; }, false);

  const myStalled = st.filter(({ copies }) => !copies.some(c => c.feed_stalled_shown_at) && vincentOn(copies)).map(({ s, copies }) => {
    const owners = actionOwners(copies.map(c => c.action_items).join('\n'));
    const mine = Object.entries(owners).filter(([who]) => VINCENT_NAME.test(who)).flatMap(([, items]) => items);
    const teammate = Object.keys(owners).some(who => TEAMMATE_NAME.test(who));
    return !mine.length && teammate ? null : { ...s, copies: copies.map(c => c.path), mine };
  }).filter(Boolean);

  const seen = new Set();
  const myNudges = nu.filter(({ copies }) => {
    const key = meetingKey(copies[0]);
    if (seen.has(key) || copies.some(c => c.feed_nudge_shown_at) || !vincentOn(copies)) return false;
    seen.add(key);
    return true;
  }).map(({ n, copies }) => ({ ...n, copies: copies.map(c => c.path) }));

  return { stalled: myStalled, nudges: myNudges, ok };
}

async function digestFacts() {
  const today = dayCT();
  const yesterday = dayCT(daysAgo(1));
  const startToday = ctMidnight(today);
  const state = await safe('feed state', async () => (await STATE().get()).data() || {}, {});

  const hr = TEAM_OUTBOUND ? await safe('HeyReach ids', hrIds, null) : null;
  const [li1, li7, em1, em7, board, nudges, stalled, notBooked, calls, yCalls, tasks, newLeads] = await Promise.all([
    hr ? safe('HeyReach 1d', () => hrStats(hr.accounts.map(a => a.id), hr.campaignIds, daysAgo(1), new Date())) : null,
    hr ? safe('HeyReach 7d', () => hrStats(hr.accounts.map(a => a.id), hr.campaignIds, daysAgo(7), new Date())) : null,
    TEAM_OUTBOUND ? safe('Instantly 1d', () => instantly(yesterday, yesterday)) : null,
    TEAM_OUTBOUND ? safe('Instantly 7d', () => instantly(dayCT(daysAgo(7)), yesterday)) : null,
    TEAM_OUTBOUND ? safe('board', getBoard, []) : [],
    safe('nudges', () => findNudgeCandidates({ marker: 'feed_nudge_shown_at' }), []),
    safe('stalled', () => findMetButStalled({ marker: 'feed_stalled_shown_at' }), []),
    TEAM_OUTBOUND ? safe('not booked', () => findInterestedNotBooked({ marker: 'feed_notbooked_shown_at' }), []) : [],
    safe('today calls', todaysCalls, []),
    safe('yesterday calls', () => callsBetween(new Date(startToday.getTime() - 86400e3), startToday), []),
    nutshell.isConfigured() ? safe('Nutshell tasks', nutshellTasksDue, null) : null,
    nutshell.isConfigured() ? safe('Nutshell leads', () => nutshellNewLeads(state.last_lead_id), null) : null,
  ]);

  // LinkedIn replies live in Reply Bot (services/replyApprovals.js), where he
  // approves each one. The digest only lists email replies and gives LinkedIn as one count.
  const isLinkedIn = b => b.channel === 'heyreach' || b.channel === 'ulinc';
  const emailBoard = board.filter(b => !isLinkedIn(b));
  const inReplyBot = await safe('Reply Bot count', async () => {
    const { db } = require('../services/db');
    return (await db.collection('reply_approvals').where('status', '==', 'pending').get()).size;
  }, 0);

  // findMetButStalled returns one item per outside person; 4+ from one call = a group meeting.
  const perCall = {};
  for (const s of stalled) perCall[s.ref.path] = (perCall[s.ref.path] || 0) + 1;
  const realStalled = stalled.filter(s => !isGroupCall(s.title, perCall[s.ref.path]));
  // Older than 3 weeks is a dead thread, not a nudge.
  const mine = await vincentsFollowups(realStalled, nudges.filter(n => n.ageDays <= 21));

  const facts = {
    kind: 'digest', date: today, weekday: new Date().toLocaleDateString('en-US', { timeZone: CT, weekday: 'long' }),
    scope: TEAM_OUTBOUND
      ? 'Vincent only: his calls, follow-ups he owes, his Nutshell tasks and leads. LinkedIn and email numbers are team outbound (sent as Aaron).'
      : 'Vincent only: his calls, follow-ups he owes, his Nutshell tasks and leads. Team outbound (LinkedIn and email sent as Aaron) is left out on purpose.',
    replies_waiting: emailBoard.slice(0, 12).map(b => ({ name: b.name, company: clip(b.company, 50), email: b.email || null, channel: 'Email', type: b.classification, hot: b.hot, draft_ready: b.hasDraft, said: clip(b.reply, 160) })),
    replies_waiting_total: emailBoard.length,
    linkedin_replies_in_reply_bot: inReplyBot,
    followups_quiet: mine.nudges.map(n => ({ path: n.ref.path, copies: n.copies, to: n.d.to, call: realText(n.t.title, 80) || n.d.to, call_date: (n.t.date || '').slice(0, 10), followup_subject: clip(n.d.subject, 100), days_since_followup: n.ageDays })),
    met_but_stalled: mine.stalled.map(s => ({ path: s.ref.path, copies: s.copies, email: s.email, call: realText(s.title, 80) || s.email, days_since_call: s.daysAgo, last_contact: s.lastContactWhat, whose_move: s.lastContactWhat === 'we emailed' ? 'theirs' : 'ours', his_action_items: clip(s.mine.join('; '), 180) || null }))
      .sort((a, b) => (a.whose_move === 'ours' ? 0 : 1) - (b.whose_move === 'ours' ? 0 : 1) || a.days_since_call - b.days_since_call),
    interested_not_booked: notBooked.map(r => ({ path: `replies/${r.id}`, email: r.email, name: r.full_name || null, company: clip(r.company_name, 50) || null, replied: r.created_at?.toDate ? dayCT(r.created_at.toDate()) : null })),
    calls_today: calls,
    calls_yesterday: yCalls,
    nutshell_tasks_due: tasks,
    nutshell_new_leads: newLeads ? newLeads.leads : null,
    linkedin_24h: li1, linkedin_7d: li7,
    email_yesterday: em1, email_7d: em7,
    sources_down: [
      TEAM_OUTBOUND && !hr && 'HeyReach', TEAM_OUTBOUND && !em7 && 'Instantly', tasks === null && 'Nutshell tasks', newLeads === null && 'Nutshell leads',
      !mine.ok && 'Fireflies (who was on each call, so follow-ups use invite lists only)',
    ].filter(Boolean),
    _mark: { last_lead_id: newLeads ? newLeads.maxId : state.last_lead_id || null, group_calls: [...new Set(stalled.filter(s => !realStalled.includes(s)).map(s => s.ref.path))] },
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
    L.push('', `Email replies waiting: ${f.replies_waiting_total}${hot.length ? ` (${hot.length} interested)` : ''}`);
    for (const r of f.replies_waiting.slice(0, 5)) L.push(`• ${r.name}${r.company ? `, ${r.company}` : ''} (${r.type})${r.draft_ready ? ', draft ready' : ''}`);
  }
  if (f.linkedin_replies_in_reply_bot) L.push(`LinkedIn: ${f.linkedin_replies_in_reply_bot} waiting in Reply Bot`);
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
  if (f.nutshell_new_leads && f.nutshell_new_leads.length) L.push('', `New Nutshell leads: ${f.nutshell_new_leads.map(l => [l.contact, l.company, l.what].filter(Boolean).join(', ')).join('; ')}`);
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
  // Outbound rates, the reply mix and the insights run are all team outbound (see TEAM_OUTBOUND).
  const hr = TEAM_OUTBOUND ? await safe('HeyReach ids', hrIds, null) : null;
  const ids = hr ? hr.accounts.map(a => a.id) : [];
  const [liThis, liPrior, emThis, emPrior, mix, held, upcoming, insights] = await Promise.all([
    hr ? safe('HeyReach this week', () => hrStats(ids, hr.campaignIds, daysAgo(7), new Date())) : null,
    hr ? safe('HeyReach prior week', () => hrStats(ids, hr.campaignIds, daysAgo(14), daysAgo(7))) : null,
    TEAM_OUTBOUND ? safe('Instantly this week', () => instantly(dayCT(daysAgo(7)), dayCT(daysAgo(1)))) : null,
    TEAM_OUTBOUND ? safe('Instantly prior week', () => instantly(dayCT(daysAgo(14)), dayCT(daysAgo(8)))) : null,
    TEAM_OUTBOUND ? safe('reply mix', classMix7d, {}) : {},
    safe('calls held', () => callsBetween(daysAgo(7), new Date()), []),
    safe('calls booked', async () => (await getEventsWindow({ daysBack: 0, daysAhead: 7 }))
      .filter(e => e.attendees.some(isExternal) && !INTERNAL_TITLES.test(e.title))
      .map(e => ({ when: `${dayCT(new Date(e.start))} ${/T/.test(e.start) ? timeCT(e.start) : ''}`.trim(), title: clip(e.title, 80) })), []),
    TEAM_OUTBOUND ? safe('insights', async () => {
      const s = await db.collection('insights').orderBy('created_at', 'desc').limit(1).get();
      if (s.empty) return null;
      const d = s.docs[0].data();
      return { date: d.date, noticing: d.noticing, icp_shift: d.icp?.shift, converting: d.icp?.converting, dead: d.icp?.dead, objections: d.objections, chase: d.chase };
    }) : null,
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
  const prospectCalls = held.filter(c => c.external_count && !isGroupCall(c.title, c.external_count));
  const heldPeople = new Set(prospectCalls.filter(c => (c.minutes || 0) >= 10).map(c => c.external[0]));
  const facts = {
    kind: 'weekly', date: today, window: `${dayCT(daysAgo(7))} to ${today}`,
    scope: TEAM_OUTBOUND
      ? 'Calls are Vincent\'s only. LinkedIn, email, reply mix and insights are team outbound (sent as Aaron).'
      : 'Vincent only: calls he was on and calls booked on his calendar. Team outbound (LinkedIn and email sent as Aaron) is left out on purpose.',
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
    sources_down: [TEAM_OUTBOUND && !hr && 'HeyReach', TEAM_OUTBOUND && !emThis && 'Instantly'].filter(Boolean),
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
    // Every notetaker's copy of the call, so another copy can't bring it back tomorrow.
    ...facts.followups_quiet.flatMap(n => (n.copies || [n.path]).map(p => [p, { feed_nudge_shown_at: at }])),
    ...facts.met_but_stalled.flatMap(s => (s.copies || [s.path]).map(p => [p, { feed_stalled_shown_at: at }])),
    ...(facts._mark?.group_calls || []).map(p => [p, { feed_stalled_shown_at: at }]),
    ...facts.interested_not_booked.map(r => [r.path, { feed_notbooked_shown_at: at }]),
  ];
  for (const [p, data] of writes) await db.doc(p).set(data, { merge: true });
  if (facts._mark?.last_lead_id) await STATE().set({ last_lead_id: facts._mark.last_lead_id, last_digest: at }, { merge: true });
  return writes.length;
}

module.exports = { digestFacts, weeklyFacts, markShown };

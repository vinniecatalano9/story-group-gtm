/*
 * Story Group GTM — Funnel Math (ES module)
 *
 * Mirrors public/tracker/funnel_math.js but exported as ES modules so the
 * React Dashboard can import it. Both files MUST stay in sync — they
 * compute the numbers Sameer reviews on the Thursday call.
 *
 * localStorage keys (shared with the standalone tracker):
 *   sg.tracker.linkedin: [{date, account, requestsSent, requestsAccepted, inmailsSent, positiveReplies, normalReplies, meetingsBooked}]
 *   sg.tracker.email:    [{date, campaign, emailsSent, openRate, positiveReplies, meetingsBooked}]
 *   sg.tracker.funnel:   [{dateBooked, prospect, company, sourceChannel, sourceAccount, showed, qualified, secondCall, closed, retainer}]
 */

export const SAMEER_TARGET_CLOSE_RATE = 0.15;
export const SAMEER_MRR_GOAL_ADDED   = 80000;
export const SAMEER_AVG_RETAINER     = 14000;

export const LS_KEYS = {
  linkedin: 'sg.tracker.linkedin',
  email:    'sg.tracker.email',
  funnel:   'sg.tracker.funnel'
};

export function loadAll() {
  const safe = k => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
  return {
    linkedin: safe(LS_KEYS.linkedin),
    email:    safe(LS_KEYS.email),
    funnel:   safe(LS_KEYS.funnel)
  };
}

export function safeDiv(n, d) { return !d ? 0 : n / d; }
export function pct(n, d) { return Math.round(safeDiv(n, d) * 1000) / 10; }

export function sumField(rows, field) {
  return rows.reduce((acc, r) => {
    const v = Number(r[field] || 0);
    return acc + (isFinite(v) ? v : 0);
  }, 0);
}

export function lastNDays(rows, dateField, n) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - n);
  cutoff.setHours(0, 0, 0, 0);
  return rows.filter(r => {
    const d = new Date(r[dateField]);
    return !isNaN(d) && d >= cutoff;
  });
}

export function groupBy(rows, key) {
  return rows.reduce((acc, r) => {
    const k = r[key] || 'unassigned';
    (acc[k] = acc[k] || []).push(r);
    return acc;
  }, {});
}

export function linkedinRollup(rows) {
  const sent     = sumField(rows, 'requestsSent');
  const accepted = sumField(rows, 'requestsAccepted');
  const inmails  = sumField(rows, 'inmailsSent');
  const pos      = sumField(rows, 'positiveReplies');
  const normal   = sumField(rows, 'normalReplies');
  const meetings = sumField(rows, 'meetingsBooked');
  return {
    requestsSent: sent,
    requestsAccepted: accepted,
    inmailsSent: inmails,
    positiveReplies: pos,
    normalReplies: normal,
    meetingsBooked: meetings,
    acceptRate: pct(accepted, sent),
    positiveReplyRate: pct(pos, accepted),
    meetingRate: pct(meetings, pos + normal),
    meetingsPerRequest: pct(meetings, sent)
  };
}

export function emailRollup(rows) {
  const sent  = sumField(rows, 'emailsSent');
  const opens = rows.reduce((acc, r) => acc + (Number(r.emailsSent || 0) * Number(r.openRate || 0) / 100), 0);
  const pos   = sumField(rows, 'positiveReplies');
  const meetings = sumField(rows, 'meetingsBooked');
  return {
    emailsSent: sent,
    estimatedOpens: Math.round(opens),
    avgOpenRate: pct(opens, sent),
    positiveReplies: pos,
    meetingsBooked: meetings,
    positiveReplyRate: pct(pos, sent),
    meetingsPerThousand: Math.round(safeDiv(meetings, sent) * 1000 * 10) / 10
  };
}

export function funnelRollup(rows) {
  const booked     = rows.length;
  const showed     = rows.filter(r => r.showed).length;
  const noShow     = rows.filter(r => r.noShow).length;
  const qualified  = rows.filter(r => r.qualified).length;
  const secondCall = rows.filter(r => r.secondCall).length;
  const closed     = rows.filter(r => r.closed).length;
  const closedLost = rows.filter(r => r.closedLost).length;
  const decided    = closed + closedLost;
  const mrrClosed  = rows.reduce((acc, r) => acc + (r.closed ? Number(r.retainer || 0) : 0), 0);
  return {
    booked, showed, noShow, qualified, secondCall, closed, closedLost, decided, mrrClosed,
    showRate: pct(showed, booked),
    noShowRate: pct(noShow, booked),
    qualifiedRate: pct(qualified, showed),
    secondCallRate: pct(secondCall, qualified),
    closeRate: pct(closed, qualified),
    decisionRate: pct(decided, qualified),
    winRate: pct(closed, decided),
    avgRetainer: closed ? Math.round(mrrClosed / closed) : 0
  };
}

export function sourceAttribution(rows) {
  const closed = rows.filter(r => r.closed);
  const byChannel = {};
  const byAccount = {};
  const mrrByChannel = {};
  closed.forEach(r => {
    const ch = r.sourceChannel || 'unknown';
    const ac = `${r.sourceChannel || 'unknown'} / ${r.sourceAccount || 'unspecified'}`;
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    byAccount[ac] = (byAccount[ac] || 0) + 1;
    mrrByChannel[ch] = (mrrByChannel[ch] || 0) + Number(r.retainer || 0);
  });
  return { byChannel, byAccount, mrrByChannel };
}

export function dailyTrend(rows, dateField, valueFields, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const iso = d.toISOString().slice(0, 10);
    const dayRows = rows.filter(r => (r[dateField] || '').slice(0, 10) === iso);
    const point = { date: iso };
    valueFields.forEach(f => { point[f] = sumField(dayRows, f); });
    out.push(point);
  }
  return out;
}

export function pathToGoal(funnelRows, days) {
  const recent = lastNDays(funnelRows, 'dateBooked', days);
  const closedRecent = recent.filter(r => r.closed);
  const mrrRecent = closedRecent.reduce((acc, r) => acc + Number(r.retainer || 0), 0);
  const mrrPerDay = safeDiv(mrrRecent, days);
  const daysToGoal = mrrPerDay > 0 ? Math.ceil(SAMEER_MRR_GOAL_ADDED / mrrPerDay) : null;

  const qualifiedRecent = recent.filter(r => r.qualified).length;
  const closeRateRecent = pct(closedRecent.length, qualifiedRecent) / 100;

  const dealsNeededAtTarget = Math.ceil(SAMEER_MRR_GOAL_ADDED / SAMEER_AVG_RETAINER);
  const qualifiedNeededAtTarget = Math.ceil(dealsNeededAtTarget / SAMEER_TARGET_CLOSE_RATE);

  return {
    days,
    mrrAddedRecent: mrrRecent,
    mrrPerDay: Math.round(mrrPerDay),
    daysToGoalAtPace: daysToGoal,
    closeRateRecent: Math.round(closeRateRecent * 1000) / 10,
    closeRateTarget: SAMEER_TARGET_CLOSE_RATE * 100,
    closeRateGapPts: Math.round((SAMEER_TARGET_CLOSE_RATE - closeRateRecent) * 1000) / 10,
    dealsNeededAtTarget,
    qualifiedNeededAtTarget,
    avgRetainerTarget: SAMEER_AVG_RETAINER,
    mrrGoal: SAMEER_MRR_GOAL_ADDED
  };
}

const TAG_PATTERNS = [
  { tag: 'budget',         rx: /\b(budget|money|cost|expensive|cheap|afford|price|pricing|too\s+small|too\s+low|funds|cash|no\s+money|priced)/i },
  { tag: 'timing',         rx: /\b(timing|too\s+early|long\s*term|later|next\s+year|next\s+quarter|not\s+ready|not\s+yet|not\s+now|future|down\s+the\s+road|q[1-4])/i },
  { tag: 'fit',            rx: /\b(not\s+a\s+good\s+fit|wrong\s+fit|not\s+(the\s+)?right|not\s+icp|not\s+aligned|different\s+niche|not\s+for\s+us)/i },
  { tag: 'decision-maker', rx: /\b(not\s+(the\s+)?decision|wrong\s+person|wrong\s+contact|\bdm\b|need\s+to\s+talk|partner|approval|boss|spouse|wife|husband)/i },
  { tag: 'priorities',     rx: /\b(other\s+priorities|focused\s+on|busy|preoccupied|head[- ]?down)/i },
  { tag: 'in-house',       rx: /\b(in[- ]?house|internal|do\s+(it\s+)?ourselves|hire\s+(in[- ]?house|internal))/i },
  { tag: 'competitor',     rx: /\b(already\s+(have|working|using)|using\s+competitor|current\s+agency|other\s+agency|with\s+another)/i },
  { tag: 'ghost',          rx: /\b(no\s+(response|reply|answer)|ghost|disappeared|never\s+heard|crickets)/i }
];

export function autoTag(notes) {
  if (!notes) return [];
  const found = [];
  TAG_PATTERNS.forEach(p => { if (p.rx.test(notes)) found.push(p.tag); });
  return found;
}

export function lostReasonBreakdown(rows) {
  const lost = rows.filter(r => r.closedLost);
  const counts = {};
  let untagged = 0;
  lost.forEach(r => {
    const tags = autoTag(r.notes);
    if (!tags.length) untagged++;
    tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  });
  const total = lost.length;
  const ranked = Object.entries(counts)
    .map(([tag, count]) => ({ tag, count, pct: total ? Math.round((count / total) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);
  return { total, ranked, untagged };
}

export function fmtMoney(n) {
  if (n == null || isNaN(n)) return '$0';
  return '$' + Math.round(n).toLocaleString();
}

export function fmtPct(n) {
  if (n == null || isNaN(n)) return '0%';
  return n + '%';
}

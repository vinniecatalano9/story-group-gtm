/*
 * Story Group GTM — Funnel Math
 * Pure functions. No DOM. Loaded by daily_tracker.html.
 *
 * Inputs are the three localStorage datasets:
 *   linkedin: [{date, account, requestsSent, requestsAccepted, inmailsSent, positiveReplies, normalReplies, meetingsBooked}]
 *   email:    [{date, campaign, emailsSent, openRate, positiveReplies, meetingsBooked}]
 *   funnel:   [{dateBooked, prospect, company, sourceChannel, sourceAccount, showed, qualified, secondCall, closed, retainer}]
 */

const SAMEER_TARGET_CLOSE_RATE = 0.15;
const SAMEER_MRR_GOAL_ADDED   = 80000;
const SAMEER_AVG_RETAINER     = 14000;

function safeDiv(n, d) {
  if (!d || d === 0) return 0;
  return n / d;
}

function pct(n, d) {
  return Math.round(safeDiv(n, d) * 1000) / 10;
}

function sumField(rows, field) {
  return rows.reduce(function (acc, r) {
    const v = Number(r[field] || 0);
    return acc + (isFinite(v) ? v : 0);
  }, 0);
}

function lastNDays(rows, dateField, n) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - n);
  cutoff.setHours(0, 0, 0, 0);
  return rows.filter(function (r) {
    const d = new Date(r[dateField]);
    return !isNaN(d) && d >= cutoff;
  });
}

function groupBy(rows, key) {
  const out = {};
  rows.forEach(function (r) {
    const k = r[key] || 'unassigned';
    if (!out[k]) out[k] = [];
    out[k].push(r);
  });
  return out;
}

function linkedinRollup(rows) {
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

function emailRollup(rows) {
  const sent     = sumField(rows, 'emailsSent');
  const opens    = rows.reduce(function (acc, r) {
    return acc + (Number(r.emailsSent || 0) * Number(r.openRate || 0) / 100);
  }, 0);
  const pos      = sumField(rows, 'positiveReplies');
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

function funnelRollup(rows) {
  const booked    = rows.length;
  const showed    = rows.filter(function (r) { return r.showed; }).length;
  const noShow    = rows.filter(function (r) { return r.noShow; }).length;
  const qualified = rows.filter(function (r) { return r.qualified; }).length;
  const secondCall = rows.filter(function (r) { return r.secondCall; }).length;
  const closed    = rows.filter(function (r) { return r.closed; }).length;
  const closedLost = rows.filter(function (r) { return r.closedLost; }).length;
  const decided   = closed + closedLost;
  const mrrClosed = rows.reduce(function (acc, r) {
    return acc + (r.closed ? Number(r.retainer || 0) : 0);
  }, 0);
  return {
    booked: booked,
    showed: showed,
    noShow: noShow,
    qualified: qualified,
    secondCall: secondCall,
    closed: closed,
    closedLost: closedLost,
    decided: decided,
    mrrClosed: mrrClosed,
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

function sourceAttribution(rows) {
  const closed = rows.filter(function (r) { return r.closed; });
  const byChannel = {};
  const byAccount = {};
  closed.forEach(function (r) {
    const ch = r.sourceChannel || 'unknown';
    const ac = (r.sourceChannel || 'unknown') + ' / ' + (r.sourceAccount || 'unspecified');
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    byAccount[ac] = (byAccount[ac] || 0) + 1;
  });
  const mrrByChannel = {};
  closed.forEach(function (r) {
    const ch = r.sourceChannel || 'unknown';
    mrrByChannel[ch] = (mrrByChannel[ch] || 0) + Number(r.retainer || 0);
  });
  return { byChannel: byChannel, byAccount: byAccount, mrrByChannel: mrrByChannel };
}

function dailyTrend(rows, dateField, valueFields, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const iso = d.toISOString().slice(0, 10);
    const dayRows = rows.filter(function (r) {
      return (r[dateField] || '').slice(0, 10) === iso;
    });
    const point = { date: iso };
    valueFields.forEach(function (f) { point[f] = sumField(dayRows, f); });
    out.push(point);
  }
  return out;
}

function pathToGoal(funnelRows, days) {
  const recent = lastNDays(funnelRows, 'dateBooked', days);
  const closedRecent = recent.filter(function (r) { return r.closed; });
  const mrrRecent = closedRecent.reduce(function (acc, r) {
    return acc + Number(r.retainer || 0);
  }, 0);
  const mrrPerDay = safeDiv(mrrRecent, days);
  const daysToGoal = mrrPerDay > 0 ? Math.ceil(SAMEER_MRR_GOAL_ADDED / mrrPerDay) : Infinity;

  const qualifiedRecent = recent.filter(function (r) { return r.qualified; }).length;
  const closeRateRecent = pct(closedRecent.length, qualifiedRecent) / 100;

  // At Sameer's 15% close rate, how many qualified meetings to hit $80k?
  const dealsNeededAtTarget = Math.ceil(SAMEER_MRR_GOAL_ADDED / SAMEER_AVG_RETAINER);
  const qualifiedNeededAtTarget = Math.ceil(dealsNeededAtTarget / SAMEER_TARGET_CLOSE_RATE);

  return {
    days: days,
    mrrAddedRecent: mrrRecent,
    mrrPerDay: Math.round(mrrPerDay),
    daysToGoalAtPace: isFinite(daysToGoal) ? daysToGoal : null,
    closeRateRecent: Math.round(closeRateRecent * 1000) / 10,
    closeRateTarget: SAMEER_TARGET_CLOSE_RATE * 100,
    closeRateGapPts: Math.round((SAMEER_TARGET_CLOSE_RATE - closeRateRecent) * 1000) / 10,
    dealsNeededAtTarget: dealsNeededAtTarget,
    qualifiedNeededAtTarget: qualifiedNeededAtTarget,
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

function autoTag(notes) {
  if (!notes) return [];
  const found = [];
  TAG_PATTERNS.forEach(function (p) { if (p.rx.test(notes)) found.push(p.tag); });
  return found;
}

function lostReasonBreakdown(rows) {
  const lost = rows.filter(function (r) { return r.closedLost; });
  const counts = {};
  let untagged = 0;
  lost.forEach(function (r) {
    const tags = autoTag(r.notes);
    if (!tags.length) untagged++;
    tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
  });
  const total = lost.length;
  const ranked = Object.keys(counts)
    .map(function (tag) {
      return { tag: tag, count: counts[tag], pct: total ? Math.round((counts[tag] / total) * 100) : 0 };
    })
    .sort(function (a, b) { return b.count - a.count; });
  return { total: total, ranked: ranked, untagged: untagged };
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '$0';
  return '$' + Math.round(n).toLocaleString();
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '0%';
  return n + '%';
}

window.FunnelMath = {
  SAMEER_TARGET_CLOSE_RATE: SAMEER_TARGET_CLOSE_RATE,
  SAMEER_MRR_GOAL_ADDED: SAMEER_MRR_GOAL_ADDED,
  SAMEER_AVG_RETAINER: SAMEER_AVG_RETAINER,
  safeDiv: safeDiv,
  pct: pct,
  sumField: sumField,
  lastNDays: lastNDays,
  groupBy: groupBy,
  linkedinRollup: linkedinRollup,
  emailRollup: emailRollup,
  funnelRollup: funnelRollup,
  sourceAttribution: sourceAttribution,
  autoTag: autoTag,
  lostReasonBreakdown: lostReasonBreakdown,
  dailyTrend: dailyTrend,
  pathToGoal: pathToGoal,
  fmtMoney: fmtMoney,
  fmtPct: fmtPct
};

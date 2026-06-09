import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  loadAll, lastNDays, linkedinRollup, emailRollup, funnelRollup,
  pathToGoal, sourceAttribution, dailyTrend, groupBy,
  lostReasonBreakdown,
  fmtMoney, pct,
  SAMEER_TARGET_CLOSE_RATE, SAMEER_MRR_GOAL_ADDED, SAMEER_AVG_RETAINER
} from '../lib/funnelMath';

const CLASSIFICATION_COLORS = {
  interested:      'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
  referral:        'bg-emerald-500/15 text-emerald-300 border border-emerald-500/25',
  more_info:       'bg-brand-500/15 text-brand-300 border border-brand-500/25',
  cost_question:   'bg-brand-500/15 text-brand-300 border border-brand-500/25',
  why_reach_out:   'bg-yellow-500/15 text-yellow-300 border border-yellow-500/25',
  question_other:  'bg-coral-500/15 text-coral-400 border border-coral-500/25',
  re_engage:       'bg-brand-500/15 text-brand-300 border border-brand-500/25',
  not_interested:  'bg-red-500/15 text-red-300 border border-red-500/25',
  ooo:             'bg-white/5 text-white/40 border border-white/10',
  bounce:          'bg-white/5 text-white/30 border border-white/10',
  other:           'bg-white/5 text-white/40 border border-white/10'
};

function pctStr(num, denom) {
  if (!denom) return '0%';
  return ((num / denom) * 100).toFixed(1) + '%';
}

export default function Dashboard({ api }) {
  const [tracker, setTracker] = useState(() => loadAll());
  const [enginePipeline, setEnginePipeline] = useState(null);
  const [engineLoading, setEngineLoading] = useState(true);

  const reloadTracker = useCallback(() => setTracker(loadAll()), []);

  useEffect(() => {
    fetch(`${api}/api/dashboard/funnel`)
      .then(r => {
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('Backend unavailable');
        return r.json();
      })
      .then(d => { if (d.success) setEnginePipeline(d.funnel); setEngineLoading(false); })
      .catch(() => setEngineLoading(false));
  }, [api]);

  useEffect(() => {
    const onFocus = () => reloadTracker();
    const onStorage = (e) => { if (e.key && e.key.startsWith('sg.tracker.')) reloadTracker(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [reloadTracker]);

  const li7 = linkedinRollup(lastNDays(tracker.linkedin, 'date', 7));
  const em7 = emailRollup(lastNDays(tracker.email, 'date', 7));
  const fnRecent7 = lastNDays(tracker.funnel, 'dateBooked', 7);
  const fn7 = funnelRollup(fnRecent7);
  const liMeetingsFunnel7 = fnRecent7.filter(r => r.sourceChannel === 'LinkedIn').length;
  const emMeetingsFunnel7 = fnRecent7.filter(r => r.sourceChannel === 'Cold Email').length;
  // Use funnel-row counts as primary source; LinkedIn/Email tab counts as fallback
  li7.meetingsBooked = liMeetingsFunnel7 || li7.meetingsBooked;
  em7.meetingsBooked = emMeetingsFunnel7 || em7.meetingsBooked;
  const path = pathToGoal(tracker.funnel, 7);
  const attribution = sourceAttribution(lastNDays(tracker.funnel, 'dateBooked', 30));
  const lostBreakdown = lostReasonBreakdown(lastNDays(tracker.funnel, 'dateBooked', 30));
  const liTrend = dailyTrend(tracker.linkedin, 'date', ['requestsSent'], 14);
  const emTrend = dailyTrend(tracker.email, 'date', ['emailsSent'], 14);
  const fnTrend = dailyTrend(
    tracker.funnel.map(r => ({ dateBooked: r.dateBooked, booked: 1 })),
    'dateBooked', ['booked'], 14
  );

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif italic text-3xl font-bold text-brand-500 leading-tight">Coaching Snapshot</h1>
          <p className="text-muted text-sm mt-1">Last 7 days · Sameer's view · refreshes when you return to this tab</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link to="/tracker" className="glass-btn-primary rounded-xl px-5 py-2.5 text-sm font-semibold">Log Today's Numbers</Link>
          <Link to="/tracker" className="px-5 py-2.5 rounded-xl text-sm font-semibold border border-navy-border text-body hover:border-brand-500/60 transition-all">Print Coaching Prep</Link>
        </div>
      </div>

      {/* Sameer's 6 KPIs */}
      <SameerStrip li7={li7} em7={em7} fn7={fn7} path={path} />

      {/* Path to $80k */}
      <PathToGoalCard path={path} fn7={fn7} />

      {/* 7-day activity rollup */}
      <ActivityRow li7={li7} em7={em7} fn7={fn7} liTrend={liTrend} emTrend={emTrend} fnTrend={fnTrend} />

      {/* Per-account / per-campaign breakdowns */}
      <BreakdownRow tracker={tracker} />

      {/* Why deals are dying — last 30 days lost-reason breakdown */}
      <LostReasons breakdown={lostBreakdown} />

      {/* Source attribution — 30 days */}
      <SourceAttribution attribution={attribution} />

      {/* Email Engine (auto via Instantly) */}
      <EnginePipelineCard funnel={enginePipeline} loading={engineLoading} />

      {/* Quick actions */}
      <QuickActionsRow api={api} />
    </div>
  );
}

function SameerStrip({ li7, em7, fn7, path }) {
  const closeRateOk = fn7.closeRate >= 15;
  const calls = fn7.booked;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Kpi label="Discovery Calls / 7d" value={calls} sub="target ~12/wk" accent />
      <Kpi label="Show Rate" value={`${fn7.showRate}%`} sub={`${fn7.showed} showed · ${fn7.noShow} no-show`} />
      <Kpi label="Qualified Rate" value={`${fn7.qualifiedRate}%`} sub={`${fn7.qualified} of ${fn7.showed}`} />
      <Kpi label="Close Rate" value={`${fn7.closeRate}%`} sub={`${fn7.closed} won · ${fn7.closedLost} lost · target 15%`} accent={!closeRateOk} good={closeRateOk} />
      <Kpi label="Avg Retainer" value={fmtMoney(fn7.avgRetainer)} sub={`target $8–14k`} />
      <Kpi label="MRR Added / 7d" value={fmtMoney(path.mrrAddedRecent)} sub={path.daysToGoalAtPace ? `${path.daysToGoalAtPace}d to $80k at pace` : 'log a close to project'} accent />
    </div>
  );
}

function Kpi({ label, value, sub, accent, good }) {
  const border = good
    ? 'border-l-2 border-l-emerald-400'
    : accent
      ? 'border-l-2 border-l-brand-500'
      : 'border-l-2 border-l-navy-border';
  return (
    <div className={`glass-card rounded-xl p-4 ${border}`}>
      <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] mb-1.5">{label}</p>
      <p className="font-serif italic text-2xl font-bold text-body leading-none">{value}</p>
      {sub && <p className="text-[11px] text-muted mt-1.5">{sub}</p>}
    </div>
  );
}

function PathToGoalCard({ path, fn7 }) {
  const gapClass = path.closeRateGapPts > 0 ? 'text-coral-500' : 'text-emerald-400';
  const gapSign = path.closeRateGapPts > 0 ? '+' : '';
  return (
    <div className="glass-card rounded-2xl p-6 border-l-2 border-l-brand-500">
      <p className="text-[10px] font-semibold text-brand-500 uppercase tracking-[0.14em] mb-3">Path to $80k MRR Added</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div>
          <p className="font-serif italic text-2xl font-bold text-body leading-none">{fmtMoney(path.mrrPerDay)}</p>
          <p className="text-[11px] text-muted mt-1.5 uppercase tracking-[0.1em]">/ Day Pace</p>
        </div>
        <div>
          <p className="font-serif italic text-2xl font-bold text-body leading-none">{path.closeRateRecent}%</p>
          <p className="text-[11px] text-muted mt-1.5 uppercase tracking-[0.1em]">7d Close Rate</p>
        </div>
        <div>
          <p className={`font-serif italic text-2xl font-bold leading-none ${gapClass}`}>{gapSign}{path.closeRateGapPts}pts</p>
          <p className="text-[11px] text-muted mt-1.5 uppercase tracking-[0.1em]">Gap vs 15% Target</p>
        </div>
        <div>
          <p className="font-serif italic text-2xl font-bold text-body leading-none">{path.dealsNeededAtTarget}</p>
          <p className="text-[11px] text-muted mt-1.5 uppercase tracking-[0.1em]">Closes Needed</p>
        </div>
      </div>
      <p className="font-serif italic text-base text-body leading-snug pl-4 border-l-2 border-l-brand-500 bg-brand-500/5 py-3 pr-4 rounded-r">
        {path.daysToGoalAtPace
          ? `${path.daysToGoalAtPace} days to $80k MRR added at current pace.`
          : 'No closes in the last 7 days — close one deal to start projecting.'}
        {' '}
        At a 15% close rate and $14k average retainer, {path.dealsNeededAtTarget} closes (~{path.qualifiedNeededAtTarget} qualified discoveries) gets you to $80k MRR added.
      </p>
    </div>
  );
}

function ActivityRow({ li7, em7, fn7, liTrend, emTrend, fnTrend }) {
  return (
    <div>
      <h2 className="font-serif text-xl font-bold text-body mb-4">Outbound Activity — Last 7 Days</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ActivityCard
          title="LinkedIn"
          trend={liTrend}
          trendField="requestsSent"
          stats={[
            { l: 'Requests Sent', v: li7.requestsSent },
            { l: 'Accepted', v: li7.requestsAccepted, sub: `${li7.acceptRate}% rate` },
            { l: 'Positive Replies', v: li7.positiveReplies },
            { l: 'Meetings Booked', v: li7.meetingsBooked }
          ]}
        />
        <ActivityCard
          title="Cold Email"
          trend={emTrend}
          trendField="emailsSent"
          accent="coral"
          stats={[
            { l: 'Emails Sent', v: em7.emailsSent.toLocaleString() },
            { l: 'Avg Open Rate', v: `${em7.avgOpenRate}%` },
            { l: 'Positive Replies', v: em7.positiveReplies },
            { l: 'Meetings Booked', v: em7.meetingsBooked }
          ]}
        />
        <ActivityCard
          title="Sales Funnel"
          trend={fnTrend}
          trendField="booked"
          stats={[
            { l: 'Calls Booked', v: fn7.booked },
            { l: 'Showed', v: fn7.showed, sub: `${fn7.showRate}% rate` },
            { l: 'Qualified', v: fn7.qualified, sub: `${fn7.qualifiedRate}% rate` },
            { l: 'Won / Lost', v: `${fn7.closed} / ${fn7.closedLost}`, sub: fmtMoney(fn7.mrrClosed) }
          ]}
        />
      </div>
    </div>
  );
}

function ActivityCard({ title, stats, trend, trendField, accent }) {
  const max = Math.max(1, ...trend.map(p => p[trendField] || 0));
  const barColor = accent === 'coral' ? 'bg-coral-500' : 'bg-brand-500';
  return (
    <div className="glass-card rounded-2xl p-5">
      <h3 className="font-serif text-lg font-bold text-body mb-3">{title}</h3>
      <div className="grid grid-cols-2 gap-3 mb-4">
        {stats.map((s, i) => (
          <div key={i}>
            <p className="font-serif italic text-xl font-bold text-body leading-none">{s.v}</p>
            <p className="text-[10px] text-muted uppercase tracking-[0.1em] mt-1">{s.l}</p>
            {s.sub && <p className="text-[10px] text-muted mt-0.5">{s.sub}</p>}
          </div>
        ))}
      </div>
      <div>
        <p className="text-[9px] text-muted uppercase tracking-[0.1em] mb-1.5">14-Day Trend</p>
        <div className="flex items-end gap-[2px] h-14">
          {trend.map((p, i) => {
            const v = p[trendField] || 0;
            const h = max === 0 ? 2 : Math.max(2, Math.round((v / max) * 40));
            return (
              <div key={i} className="flex-1 flex flex-col items-stretch justify-end min-w-0 group" title={`${p.date}: ${v}`}>
                <div className="text-[9px] text-body text-center font-bold leading-[12px] h-3">{v > 0 ? v : '·'}</div>
                <div className={`${barColor} rounded-t-sm opacity-90 group-hover:opacity-100`} style={{ height: `${h}px` }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BreakdownRow({ tracker }) {
  const liByAccount = groupBy(lastNDays(tracker.linkedin, 'date', 7), 'account');
  const emByCampaign = groupBy(lastNDays(tracker.email, 'date', 7), 'campaign');
  const liRows = Object.entries(liByAccount).map(([k, v]) => ({ k, r: linkedinRollup(v) }));
  const emRows = Object.entries(emByCampaign).map(([k, v]) => ({ k, r: emailRollup(v) }));

  if (!liRows.length && !emRows.length) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {liRows.length > 0 && (
        <div className="glass-card rounded-2xl p-5">
          <h3 className="font-serif text-lg font-bold text-body mb-3">LinkedIn — Per Account (7d)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-border">
                  <th className="text-left py-2 pr-3 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Account</th>
                  <th className="text-right py-2 px-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Sent</th>
                  <th className="text-right py-2 px-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Accept%</th>
                  <th className="text-right py-2 pl-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Mtgs</th>
                </tr>
              </thead>
              <tbody>
                {liRows.map(({ k, r }) => (
                  <tr key={k} className="border-b border-navy-border/50">
                    <td className="py-2 pr-3 text-body truncate max-w-[160px]">{k}</td>
                    <td className="py-2 px-2 text-right text-body">{r.requestsSent}</td>
                    <td className="py-2 px-2 text-right text-brand-300">{r.acceptRate}%</td>
                    <td className="py-2 pl-2 text-right text-body">{r.meetingsBooked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {emRows.length > 0 && (
        <div className="glass-card rounded-2xl p-5">
          <h3 className="font-serif text-lg font-bold text-body mb-3">Cold Email — Per Campaign (7d)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-border">
                  <th className="text-left py-2 pr-3 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Campaign</th>
                  <th className="text-right py-2 px-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Sent</th>
                  <th className="text-right py-2 px-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Open%</th>
                  <th className="text-right py-2 pl-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Mtgs</th>
                </tr>
              </thead>
              <tbody>
                {emRows.map(({ k, r }) => (
                  <tr key={k} className="border-b border-navy-border/50">
                    <td className="py-2 pr-3 text-body truncate max-w-[200px]">{k}</td>
                    <td className="py-2 px-2 text-right text-body">{r.emailsSent.toLocaleString()}</td>
                    <td className="py-2 px-2 text-right text-coral-400">{r.avgOpenRate}%</td>
                    <td className="py-2 pl-2 text-right text-body">{r.meetingsBooked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function LostReasons({ breakdown }) {
  if (!breakdown || breakdown.total === 0) return null;
  const top = breakdown.ranked[0];
  const insight = top
    ? `${top.pct}% of your lost deals in the last 30 days carry a "${top.tag}" objection (${top.count} of ${breakdown.total}). ${
        top.tag === 'budget'    ? 'Your ICP filter is letting through prospects who can\'t afford the tier — qualify earlier.' :
        top.tag === 'timing'    ? 'You\'re catching them too early in the cycle — add a nurture sequence or follow-up cadence.' :
        top.tag === 'fit'       ? 'Tighten the ICP at the outreach stage so non-fits never book.' :
        top.tag === 'decision-maker' ? 'Add a question on Call 1 to flag DM access early.' :
        'Bring this pattern to Sameer — it\'s your highest-leverage funnel leak.'
      }`
    : '';
  return (
    <div className="glass-card rounded-2xl p-5 border-l-2 border-l-coral-500">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="font-serif text-lg font-bold text-body">Why You're Losing Deals — Last 30 Days</h3>
        <span className="text-[10px] text-muted uppercase tracking-[0.12em]">{breakdown.total} lost</span>
      </div>
      {insight && <p className="font-serif italic text-base text-body leading-snug pl-4 border-l-2 border-l-coral-500 bg-coral-500/5 py-3 pr-4 rounded-r mt-3 mb-4">{insight}</p>}
      <div className="flex flex-wrap gap-2 mt-3">
        {breakdown.ranked.map(r => (
          <div key={r.tag} className="px-3 py-1.5 rounded-lg text-xs bg-coral-500/15 text-coral-400 border border-coral-500/30">
            <span className="font-bold">{r.count}</span>
            <span className="ml-1.5 capitalize">{r.tag.replace('-', ' ')}</span>
            <span className="ml-1.5 opacity-70">{r.pct}%</span>
          </div>
        ))}
        {breakdown.untagged > 0 && (
          <div className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-muted border border-white/10">
            <span className="font-bold">{breakdown.untagged}</span>
            <span className="ml-1.5">unlabeled</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceAttribution({ attribution }) {
  const channels = Object.entries(attribution.byChannel);
  if (!channels.length) return null;
  return (
    <div className="glass-card rounded-2xl p-5">
      <h3 className="font-serif text-lg font-bold text-body mb-3">Closed Deals — Last 30 Days by Source</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-border">
              <th className="text-left py-2 pr-3 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Channel</th>
              <th className="text-right py-2 px-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">Closes</th>
              <th className="text-right py-2 pl-2 text-[10px] uppercase tracking-[0.12em] text-muted font-semibold">MRR Closed</th>
            </tr>
          </thead>
          <tbody>
            {channels.map(([k, count]) => (
              <tr key={k} className="border-b border-navy-border/50">
                <td className="py-2 pr-3 text-body">{k}</td>
                <td className="py-2 px-2 text-right text-body">{count}</td>
                <td className="py-2 pl-2 text-right text-brand-300 font-semibold">{fmtMoney(attribution.mrrByChannel[k] || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EnginePipelineCard({ funnel, loading }) {
  if (loading) return <p className="text-muted text-center py-6">Loading email engine stats…</p>;
  if (!funnel || !funnel.sent) {
    return (
      <div className="glass-card rounded-2xl p-5">
        <h3 className="font-serif text-lg font-bold text-body mb-1">Email Engine (Auto via Instantly)</h3>
        <p className="text-muted text-sm">No email engine data yet. Once Instantly is sending, top-of-funnel volume shows up here.</p>
      </div>
    );
  }

  const stages = [
    { key: 'sent',     label: 'Sent',     color: 'from-brand-700/60 to-brand-800/40' },
    { key: 'opened',   label: 'Opened',   color: 'from-brand-500/60 to-brand-600/40' },
    { key: 'replied',  label: 'Replied',  color: 'from-coral-500/60 to-coral-600/40' },
    { key: 'positive', label: 'Positive', color: 'from-emerald-500/60 to-emerald-600/40' }
  ];

  return (
    <div className="glass-card rounded-2xl p-6">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="font-serif text-lg font-bold text-body">Email Engine (Auto via Instantly)</h3>
        <span className="text-[10px] text-muted uppercase tracking-[0.12em]">Top of funnel · system data</span>
      </div>
      <p className="text-muted text-xs mb-4">Booked → Closed live in the Coaching Snapshot above. This is the upstream send → reply pipeline only.</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {stages.map(s => (
          <div key={s.key} className="glass-card rounded-xl p-4 border-l-2 border-l-brand-500/40">
            <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.12em] mb-1">{s.label}</p>
            <p className="font-serif italic text-2xl font-bold text-body leading-none">{(funnel[s.key] || 0).toLocaleString()}</p>
            {s.key !== 'sent' && (
              <p className="text-[11px] text-muted mt-1.5">{pctStr(funnel[s.key] || 0, funnel.sent)} of sent</p>
            )}
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {stages.map((s, i) => {
          const value = funnel[s.key] || 0;
          const maxVal = funnel.sent || 1;
          const widthPct = Math.max((value / maxVal) * 100, 3);
          const prev = i > 0 ? (funnel[stages[i - 1].key] || 0) : null;
          return (
            <div key={s.key} className="flex items-center gap-3">
              <span className="text-xs text-muted w-20 text-right font-medium">{s.label}</span>
              <div className="flex-1 bg-white/5 rounded-full h-8 overflow-hidden border border-navy-border">
                <div className={`bg-gradient-to-r ${s.color} h-full rounded-full flex items-center px-3 transition-all duration-700`} style={{ width: `${widthPct}%` }}>
                  <span className="text-white text-xs font-bold">{value.toLocaleString()}</span>
                </div>
              </div>
              <span className="text-[11px] text-muted w-14">{prev != null && prev > 0 ? pctStr(value, prev) : ''}</span>
            </div>
          );
        })}
      </div>

      {funnel.classificationCounts && Object.keys(funnel.classificationCounts).length > 0 && (
        <div className="mt-6 pt-5 border-t border-navy-border">
          <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.12em] mb-3">Reply Categories</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(funnel.classificationCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([cls, count]) => (
                <div key={cls} className={`px-3 py-1.5 rounded-lg text-xs ${CLASSIFICATION_COLORS[cls] || 'bg-white/5 text-white/40 border border-white/10'}`}>
                  <span className="font-bold">{count}</span>
                  <span className="ml-1.5 capitalize opacity-80">{cls.replace(/_/g, ' ')}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuickActionsRow({ api }) {
  return (
    <div className="glass-card rounded-2xl p-5">
      <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.12em] mb-3">System Actions</p>
      <div className="flex gap-2 flex-wrap">
        <ActionButton api={api} endpoint="/api/enrich"           label="Run Enrichment" method="POST" />
        <ActionButton api={api} endpoint="/api/trigger/cleanup"  label="Run Cleanup"    method="POST" />
        <ActionButton api={api} endpoint="/api/trigger/dashboard" label="Generate Report" method="POST" />
      </div>
    </div>
  );
}

function ActionButton({ api, endpoint, label, method }) {
  const [status, setStatus] = useState('idle');
  const run = async () => {
    setStatus('running');
    try {
      const res = await fetch(`${api}${endpoint}`, { method });
      const data = await res.json();
      setStatus(data.success ? 'done' : 'error');
      setTimeout(() => setStatus('idle'), 3000);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };
  return (
    <button
      onClick={run}
      disabled={status === 'running'}
      className={`px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-[0.1em] transition-all ${
        status === 'running' ? 'bg-white/5 text-white/30 cursor-wait border border-white/5' :
        status === 'done'    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
        status === 'error'   ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
        'border border-navy-border text-muted hover:text-body hover:border-brand-500/60'
      }`}
    >
      {status === 'running' ? 'Running…' : status === 'done' ? 'Done' : status === 'error' ? 'Error' : label}
    </button>
  );
}

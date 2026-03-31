import { useState, useEffect } from 'react';

const FUNNEL_STAGES = [
  { key: 'sent', label: 'Emails Sent', color: 'from-blue-500/60 to-blue-600/40', text: 'text-blue-400', glow: '0 0 20px rgba(59,130,246,0.3)' },
  { key: 'opened', label: 'Opened', color: 'from-sky-500/60 to-sky-600/40', text: 'text-sky-400', glow: '0 0 20px rgba(56,189,248,0.3)' },
  { key: 'replied', label: 'Replied', color: 'from-indigo-500/60 to-indigo-600/40', text: 'text-indigo-400', glow: '0 0 20px rgba(129,140,248,0.3)' },
  { key: 'positive', label: 'Positive', color: 'from-emerald-500/60 to-emerald-600/40', text: 'text-emerald-400', glow: '0 0 20px rgba(52,211,153,0.3)' },
  { key: 'booked', label: 'Booked', color: 'from-green-400/70 to-emerald-500/50', text: 'text-green-400', glow: '0 0 20px rgba(74,222,128,0.3)' },
  { key: 'meetings_held', label: 'Meetings Held', color: 'from-teal-500/60 to-teal-600/40', text: 'text-teal-400', glow: '0 0 20px rgba(45,212,191,0.3)' },
  { key: 'second_calls_booked', label: '2nd Calls', color: 'from-purple-500/60 to-purple-600/40', text: 'text-purple-400', glow: '0 0 20px rgba(168,85,247,0.3)' },
  { key: 'closed_deals', label: 'Closed Deals', color: 'from-amber-500/60 to-yellow-500/40', text: 'text-amber-400', glow: '0 0 20px rgba(245,158,11,0.3)' },
];

const CLASSIFICATION_COLORS = {
  interested: 'bg-green-500/15 text-green-400 border border-green-500/20',
  referral: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20',
  more_info: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
  cost_question: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20',
  why_reach_out: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20',
  question_other: 'bg-orange-500/15 text-orange-400 border border-orange-500/20',
  re_engage: 'bg-purple-500/15 text-purple-400 border border-purple-500/20',
  not_interested: 'bg-red-500/15 text-red-400 border border-red-500/20',
  ooo: 'bg-white/5 text-white/40 border border-white/10',
  bounce: 'bg-white/5 text-white/30 border border-white/10',
  other: 'bg-white/5 text-white/40 border border-white/10',
};

function pct(num, denom) {
  if (!denom) return '0%';
  return ((num / denom) * 100).toFixed(1) + '%';
}

export default function Dashboard({ api }) {
  const [stats, setStats] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [funnelLoading, setFunnelLoading] = useState(true);

  useEffect(() => {
    fetch(`${api}/api/dashboard`)
      .then(r => {
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('Backend unavailable');
        return r.json();
      })
      .then(d => { setStats(d.stats); setLoading(false); })
      .catch(() => setLoading(false));

    fetch(`${api}/api/dashboard/funnel`)
      .then(r => {
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('Backend unavailable');
        return r.json();
      })
      .then(d => {
        if (d.success) setFunnel(d.funnel);
        setFunnelLoading(false);
      })
      .catch(() => { setFunnelLoading(false); });
  }, [api]);

  if (loading && funnelLoading) return <p className="text-white/30 py-10 text-center">Loading...</p>;

  const total = stats ? Object.values(stats).reduce((a, b) => a + b, 0) : 0;
  const replyRate = stats?.emailed > 0 ? ((stats.replied / stats.emailed) * 100).toFixed(1) : '0';
  const bookRate = stats?.replied > 0 ? ((stats.booked / stats.replied) * 100).toFixed(1) : '0';

  // Last 7 days positive count
  const last7Positive = funnel?.dailyPositive
    ? (() => {
        const now = new Date();
        let count = 0;
        for (let i = 0; i < 7; i++) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          const key = d.toISOString().slice(0, 10);
          count += funnel.dailyPositive[key] || 0;
        }
        return count;
      })()
    : 0;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-white">Pipeline Dashboard</h1>

      {/* Top KPI Cards — always visible */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <KPICard label="Total Leads" value={total} color="text-white" />
        <KPICard label="Scored" value={stats?.scored || 0} color="text-indigo-400" />
        <KPICard label="Emailed" value={stats?.emailed || 0} color="text-purple-400" />
        <KPICard label="Reply Rate" value={`${replyRate}%`} color="text-green-400" />
        <KPICard label="Booked" value={stats?.booked || 0} color="text-emerald-400" />
        <KPICard label="Last 7 Days" value={last7Positive} sublabel="positive replies" color="text-amber-400" />
      </div>

      {/* Lead Pipeline Funnel — horizontal bars */}
      {stats && (() => {
        const STAGES = [
          { key: 'ingested', label: 'Ingested', color: 'from-slate-500/60 to-slate-600/40' },
          { key: 'enriched', label: 'Enriched', color: 'from-blue-500/60 to-blue-600/40' },
          { key: 'scored', label: 'Scored', color: 'from-indigo-500/60 to-indigo-600/40' },
          { key: 'emailed', label: 'Emailed', color: 'from-purple-500/60 to-purple-600/40' },
          { key: 'replied', label: 'Replied', color: 'from-emerald-500/60 to-emerald-600/40' },
          { key: 'booked', label: 'Booked', color: 'from-green-400/70 to-emerald-500/50' },
          { key: 'closed', label: 'Closed', color: 'from-amber-500/60 to-yellow-500/40' },
        ];
        return (
          <div className="glass-card rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-white/90 mb-2">Lead Pipeline</h2>
            <p className="text-sm text-white/30 mb-4">Lead status breakdown ({total.toLocaleString()} total)</p>
            <div className="space-y-3">
              {STAGES.map(s => {
                const val = stats[s.key] || 0;
                const widthPct = total > 0 ? Math.max((val / total) * 100, 2) : 0;
                return (
                  <div key={s.key} className="flex items-center gap-3">
                    <span className="text-sm text-white/40 w-20 text-right font-medium">{s.label}</span>
                    <div className="flex-1 bg-white/5 rounded-full h-9 overflow-hidden border border-white/5">
                      <div
                        className={`bg-gradient-to-r ${s.color} h-full rounded-full flex items-center px-3 transition-all duration-500 backdrop-blur-sm`}
                        style={{ width: `${widthPct}%` }}
                      >
                        <span className="text-white text-xs font-semibold drop-shadow-sm">{val}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Email Funnel (from Instantly) */}
      {!funnelLoading && funnel && funnel.sent > 0 && (
        <>
          {/* Email funnel KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
            {FUNNEL_STAGES.map(s => (
              <div key={s.key} className="glass-card glass-card-hover rounded-2xl p-5">
                <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-1">{s.label}</p>
                <p className={`text-3xl font-bold ${s.text}`} style={{ textShadow: s.glow }}>
                  {(funnel[s.key] || 0).toLocaleString()}
                </p>
                {s.key !== 'sent' && funnel.sent > 0 && (
                  <p className="text-xs text-white/30 mt-1">{pct(funnel[s.key] || 0, funnel.sent)} of sent</p>
                )}
              </div>
            ))}
          </div>

          {/* Conversion Funnel Visual */}
          <div className="glass-card rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-white/90 mb-2">Email Funnel</h2>
            <p className="text-sm text-white/30 mb-5">Sent → Opened → Replied → Positive → Booked → Held → 2nd Call → Closed</p>
            <div className="space-y-3">
              {FUNNEL_STAGES.map((s, i) => {
                const value = funnel[s.key] || 0;
                const maxVal = funnel.sent || 1;
                const widthPct = Math.max((value / maxVal) * 100, 3);
                const prevKey = i > 0 ? FUNNEL_STAGES[i - 1].key : null;
                const prevVal = prevKey ? (funnel[prevKey] || 0) : null;
                return (
                  <div key={s.key} className="flex items-center gap-3">
                    <span className="text-sm text-white/40 w-36 text-right font-medium">{s.label}</span>
                    <div className="flex-1 bg-white/5 rounded-full h-10 overflow-hidden border border-white/5">
                      <div
                        className={`bg-gradient-to-r ${s.color} h-full rounded-full flex items-center px-4 transition-all duration-700 backdrop-blur-sm`}
                        style={{ width: `${widthPct}%` }}
                      >
                        <span className="text-white text-sm font-bold drop-shadow-sm">{value.toLocaleString()}</span>
                      </div>
                    </div>
                    <span className="text-xs text-white/30 w-16">
                      {prevVal != null && prevVal > 0 ? pct(value, prevVal) : ''}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Constraint identifier */}
            {funnel.sent > 0 && (() => {
              const steps = FUNNEL_STAGES.map((s, i) => ({
                ...s,
                value: funnel[s.key] || 0,
                dropPct: i > 0 ? (1 - (funnel[s.key] || 0) / Math.max(funnel[FUNNEL_STAGES[i - 1].key] || 1, 1)) * 100 : 0,
              }));
              const worst = steps.slice(1).reduce((a, b) => b.dropPct > a.dropPct ? b : a);
              return worst.dropPct > 0 ? (
                <div className="mt-5 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                  <p className="text-sm font-medium text-amber-400">
                    Biggest drop-off: <span className="font-bold">{worst.label}</span> — {worst.dropPct.toFixed(1)}% drop from previous stage
                  </p>
                  <p className="text-xs text-amber-400/60 mt-1">This is the constraint in your conveyor belt. Focus optimization here.</p>
                </div>
              ) : null;
            })()}
          </div>

          {/* Per-Campaign Breakdown */}
          {funnel.campaignBreakdown?.length > 0 && (
            <div className="glass-card rounded-2xl p-6">
              <h2 className="text-lg font-semibold text-white/90 mb-4">Campaign Breakdown</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left py-2 px-3 font-medium text-white/40">Campaign</th>
                      <th className="text-right py-2 px-3 font-medium text-white/40">Sent</th>
                      <th className="text-right py-2 px-3 font-medium text-white/40">Opened</th>
                      <th className="text-right py-2 px-3 font-medium text-white/40">Open %</th>
                      <th className="text-right py-2 px-3 font-medium text-white/40">Replied</th>
                      <th className="text-right py-2 px-3 font-medium text-white/40">Reply %</th>
                      <th className="text-right py-2 px-3 font-medium text-white/40">Bounced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.campaignBreakdown.map((c, i) => (
                      <tr key={c.id || i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="py-2 px-3 text-white/80 font-medium truncate max-w-[250px]">{c.name}</td>
                        <td className="py-2 px-3 text-right text-white/60">{c.sent.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right text-white/60">{c.opened.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right text-sky-400 font-medium">{pct(c.opened, c.sent)}</td>
                        <td className="py-2 px-3 text-right text-white/60">{c.replied.toLocaleString()}</td>
                        <td className="py-2 px-3 text-right text-indigo-400 font-medium">{pct(c.replied, c.sent)}</td>
                        <td className="py-2 px-3 text-right text-red-400">{c.bounced.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Reply Classification Breakdown */}
      {funnel?.classificationCounts && Object.keys(funnel.classificationCounts).length > 0 && (
        <div className="glass-card rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white/90 mb-4">Reply Categories</h2>
          <div className="flex flex-wrap gap-3">
            {Object.entries(funnel.classificationCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([cls, count]) => (
                <div key={cls} className={`px-4 py-2.5 rounded-xl ${CLASSIFICATION_COLORS[cls] || 'bg-white/5 text-white/40 border border-white/10'}`}>
                  <span className="text-lg font-bold">{count}</span>
                  <span className="text-sm ml-2 capitalize opacity-80">{cls.replace(/_/g, ' ')}</span>
                </div>
              ))
            }
          </div>
        </div>
      )}

      {/* Daily Positive Responses */}
      {funnel?.dailyPositive && Object.keys(funnel.dailyPositive).length > 0 && (
        <div className="glass-card rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-white/90 mb-4">Positive Responses — Last 30 Days</h2>
          <div className="space-y-2">
            {Object.entries(funnel.dailyPositive)
              .sort((a, b) => b[0].localeCompare(a[0]))
              .slice(0, 30)
              .map(([day, count]) => {
                const max = Math.max(...Object.values(funnel.dailyPositive));
                return (
                  <div key={day} className="flex items-center gap-3">
                    <span className="text-sm text-white/40 w-24 font-mono">{day}</span>
                    <div className="flex-1 bg-white/5 rounded h-6 overflow-hidden border border-white/5">
                      <div
                        className="bg-gradient-to-r from-green-500/60 to-emerald-500/40 h-full rounded flex items-center px-2 transition-all"
                        style={{ width: `${Math.max((count / max) * 100, 8)}%` }}
                      >
                        <span className="text-white text-xs font-bold">{count}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            }
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="glass-card rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white/90 mb-4">Quick Actions</h2>
        <div className="flex gap-3 flex-wrap">
          <ActionButton api={api} endpoint="/api/enrich" label="Run Enrichment" method="POST" />
          <ActionButton api={api} endpoint="/api/trigger/cleanup" label="Run Cleanup" method="POST" />
          <ActionButton api={api} endpoint="/api/trigger/dashboard" label="Generate Report" method="POST" />
        </div>
      </div>
    </div>
  );
}

function KPICard({ label, value, sublabel, color }) {
  return (
    <div className="glass-card glass-card-hover rounded-2xl p-5">
      <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-bold ${color || 'text-white'}`}>{typeof value === 'number' ? value.toLocaleString() : value}</p>
      {sublabel && <p className="text-xs text-white/30 mt-1">{sublabel}</p>}
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
      className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
        status === 'running' ? 'bg-white/5 text-white/30 cursor-wait border border-white/5' :
        status === 'done' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
        status === 'error' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
        'glass-btn-primary rounded-xl'
      }`}
    >
      {status === 'running' ? 'Running...' : status === 'done' ? 'Done!' : status === 'error' ? 'Error' : label}
    </button>
  );
}

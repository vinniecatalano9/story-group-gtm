import { useState, useEffect } from 'react';

const STAGES = [
  { key: 'ingested', label: 'Ingested', color: 'bg-gray-400' },
  { key: 'enriched', label: 'Enriched', color: 'bg-blue-400' },
  { key: 'scored', label: 'Scored', color: 'bg-indigo-400' },
  { key: 'emailed', label: 'Emailed', color: 'bg-purple-500' },
  { key: 'replied', label: 'Replied', color: 'bg-green-500' },
  { key: 'booked', label: 'Booked', color: 'bg-emerald-600' },
];

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-bold ${color || 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

function FunnelBar({ label, value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-20 text-right">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-8 overflow-hidden">
        <div
          className={`${color} h-full rounded-full flex items-center px-3 transition-all duration-500`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        >
          <span className="text-white text-xs font-medium">{value}</span>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard({ api }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${api}/api/dashboard`)
      .then(r => r.json())
      .then(d => { setStats(d.stats); setLoading(false); })
      .catch(() => setLoading(false));
  }, [api]);

  if (loading) return <p className="text-gray-400 py-10 text-center">Loading...</p>;
  if (!stats) return <p className="text-gray-400 py-10 text-center">No data yet. Ingest some leads to get started.</p>;

  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const replyRate = stats.emailed > 0 ? ((stats.replied / stats.emailed) * 100).toFixed(1) : '0';
  const bookRate = stats.replied > 0 ? ((stats.booked / stats.replied) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Pipeline Dashboard</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Leads" value={total} />
        <StatCard label="Emailed" value={stats.emailed || 0} color="text-purple-600" />
        <StatCard label="Reply Rate" value={`${replyRate}%`} color="text-green-600" />
        <StatCard label="Booked" value={stats.booked || 0} color="text-emerald-600" />
      </div>

      {/* Funnel */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Pipeline Funnel</h2>
        <div className="space-y-3">
          {STAGES.map(s => (
            <FunnelBar key={s.key} label={s.label} value={stats[s.key] || 0} max={total} color={s.color} />
          ))}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Quick Actions</h2>
        <div className="flex gap-3 flex-wrap">
          <ActionButton api={api} endpoint="/api/enrich" label="Run Enrichment" method="POST" />
          <ActionButton api={api} endpoint="/api/trigger/cleanup" label="Run Cleanup" method="POST" />
          <ActionButton api={api} endpoint="/api/trigger/dashboard" label="Generate Report" method="POST" />
        </div>
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
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
        status === 'running' ? 'bg-gray-200 text-gray-500 cursor-wait' :
        status === 'done' ? 'bg-green-100 text-green-700' :
        status === 'error' ? 'bg-red-100 text-red-700' :
        'bg-brand-50 text-brand-700 hover:bg-brand-100'
      }`}
    >
      {status === 'running' ? 'Running...' : status === 'done' ? 'Done!' : status === 'error' ? 'Error' : label}
    </button>
  );
}

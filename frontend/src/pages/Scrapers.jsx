import { useState, useEffect } from 'react';

const STATUS_COLORS = {
  idle: 'bg-white/10 text-white/50',
  running: 'bg-yellow-500/15 text-yellow-400',
  error: 'bg-red-500/15 text-red-400',
};

export default function Scrapers({ api }) {
  const [scrapers, setScrapers] = useState([]);
  const [registry, setRegistry] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    Promise.all([
      fetch(`${api}/api/scrapers`).then(r => r.json()),
      fetch(`${api}/api/scrapers/registry`).then(r => r.json()),
    ])
      .then(([s, r]) => {
        setScrapers(s.scrapers || []);
        setRegistry(r.registry || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, [api]);

  if (loading) return <p className="text-white/30 py-10 text-center">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Scrapers</h1>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="glass-btn-primary px-4 py-2 rounded-xl text-sm"
        >
          + Add Scraper
        </button>
      </div>

      {showAdd && <AddScraper api={api} registry={registry} onDone={() => { setShowAdd(false); load(); }} />}

      {scrapers.length === 0 ? (
        <p className="text-white/30 text-center py-10">No scrapers configured. Add one to start sourcing leads.</p>
      ) : (
        <div className="grid gap-4">
          {scrapers.map(s => (
            <ScraperCard key={s.id} scraper={s} api={api} onRefresh={load} />
          ))}
        </div>
      )}

      <div className="glass-card rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white/90 mb-3">Available Scraper Types</h2>
        <div className="grid gap-3">
          {registry.map(r => (
            <div key={r.type} className="flex items-start gap-3 p-3 bg-white/5 rounded-xl border border-white/5">
              <div className="text-2xl">🔍</div>
              <div>
                <p className="font-medium text-white/80">{r.name}</p>
                <p className="text-sm text-white/40">{r.description}</p>
                <p className="text-xs text-white/20 mt-1 font-mono">{r.type}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScraperCard({ scraper, api, onRefresh }) {
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState(null);

  const runScraper = async () => {
    setRunning(true);
    try {
      await fetch(`${api}/api/scrapers/${scraper.id}/run`, { method: 'POST' });
      setTimeout(() => { setRunning(false); onRefresh(); }, 3000);
    } catch {
      setRunning(false);
    }
  };

  const deleteScraper = async () => {
    if (!confirm('Delete this scraper?')) return;
    await fetch(`${api}/api/scrapers/${scraper.id}`, { method: 'DELETE' });
    onRefresh();
  };

  const loadRuns = async () => {
    if (runs) { setExpanded(!expanded); return; }
    const r = await fetch(`${api}/api/scrapers/${scraper.id}/runs`).then(r => r.json());
    setRuns(r.runs || []);
    setExpanded(true);
  };

  const lastRun = scraper.last_run
    ? new Date(scraper.last_run._seconds ? scraper.last_run._seconds * 1000 : scraper.last_run).toLocaleDateString()
    : 'Never';

  return (
    <div className="glass-card glass-card-hover rounded-2xl p-5">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-white/90">{scraper.name}</h3>
            <span className={`text-xs px-2.5 py-0.5 rounded-lg font-medium border border-white/5 ${STATUS_COLORS[scraper.status] || STATUS_COLORS.idle}`}>
              {scraper.status}
            </span>
          </div>
          <p className="text-sm text-white/30 mt-1 font-mono">{scraper.type}</p>
          <div className="flex gap-6 mt-3 text-sm text-white/50">
            <span>Tag: <strong className="text-white/70">{scraper.campaign_tag}</strong></span>
            <span>Last run: <strong className="text-white/70">{lastRun}</strong></span>
            <span>Total leads: <strong className="text-white/70">{scraper.total_leads || 0}</strong></span>
            <span>Runs: <strong className="text-white/70">{scraper.run_count || 0}</strong></span>
            {scraper.last_run_leads > 0 && (
              <span>Last batch: <strong className="text-white/70">{scraper.last_run_leads}</strong></span>
            )}
          </div>
          {scraper.last_error && (
            <p className="text-xs text-red-400 mt-2">Error: {scraper.last_error}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadRuns}
            className="px-3 py-1.5 text-sm text-white/50 bg-white/5 rounded-xl hover:bg-white/10 border border-white/5 transition-all"
          >
            History
          </button>
          <button
            onClick={runScraper}
            disabled={running || scraper.status === 'running'}
            className={`px-4 py-1.5 text-sm font-medium rounded-xl transition-all ${
              running || scraper.status === 'running'
                ? 'bg-white/5 text-white/30 cursor-wait border border-white/5'
                : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20'
            }`}
          >
            {running || scraper.status === 'running' ? 'Running...' : 'Run'}
          </button>
          <button
            onClick={deleteScraper}
            className="px-3 py-1.5 text-sm text-red-400 bg-red-500/10 rounded-xl hover:bg-red-500/20 border border-red-500/15 transition-all"
          >
            ✕
          </button>
        </div>
      </div>

      {expanded && runs && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <h4 className="text-sm font-medium text-white/60 mb-2">Run History</h4>
          {runs.length === 0 ? (
            <p className="text-sm text-white/30">No runs yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-white/30 text-xs">
                  <th className="pb-1">Date</th>
                  <th className="pb-1">Raw</th>
                  <th className="pb-1">Firms</th>
                  <th className="pb-1">Ingested</th>
                  <th className="pb-1">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="border-t border-white/5">
                    <td className="py-1.5 text-white/50">
                      {new Date(r.created_at._seconds ? r.created_at._seconds * 1000 : r.created_at).toLocaleString()}
                    </td>
                    <td className="text-white/50">{r.total_raw}</td>
                    <td className="text-white/50">{r.unique_firms}</td>
                    <td className="font-medium text-white/70">{r.leads_ingested}</td>
                    <td className="text-white/50">{r.duration_seconds}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function AddScraper({ api, registry, onDone }) {
  const [name, setName] = useState('');
  const [type, setType] = useState(registry[0]?.type || '');
  const [tag, setTag] = useState('');
  const [saving, setSaving] = useState(false);

  const selected = registry.find(r => r.type === type);

  const save = async () => {
    if (!name || !type) return;
    setSaving(true);
    await fetch(`${api}/api/scrapers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        type,
        campaign_tag: tag || `${type}-leads`,
        config: selected?.defaultConfig,
      }),
    });
    onDone();
  };

  return (
    <div className="glass-card rounded-2xl p-5">
      <h3 className="font-semibold text-white/90 mb-4">New Scraper</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-white/40 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g., FL Political Consultants"
            className="glass-input w-full rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-white/40 mb-1">Type</label>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="glass-input w-full rounded-xl px-3 py-2 text-sm"
          >
            {registry.map(r => (
              <option key={r.type} value={r.type}>{r.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-white/40 mb-1">Campaign Tag</label>
          <input
            type="text"
            value={tag}
            onChange={e => setTag(e.target.value)}
            placeholder={`${type}-leads`}
            className="glass-input w-full rounded-xl px-3 py-2 text-sm"
          />
        </div>
      </div>
      {selected && (
        <p className="text-sm text-white/40 mt-3">{selected.description}</p>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onDone} className="px-4 py-2 text-sm text-white/40 hover:bg-white/5 rounded-xl transition-all">Cancel</button>
        <button
          onClick={save}
          disabled={saving || !name}
          className="glass-btn-primary px-4 py-2 text-sm rounded-xl disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Create Scraper'}
        </button>
      </div>
    </div>
  );
}

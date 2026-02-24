import { useState, useEffect } from 'react';

const STATUS_COLORS = {
  idle: 'bg-gray-100 text-gray-700',
  running: 'bg-yellow-100 text-yellow-800',
  error: 'bg-red-100 text-red-700',
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

  if (loading) return <p className="text-gray-400 py-10 text-center">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Scrapers</h1>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700"
        >
          + Add Scraper
        </button>
      </div>

      {showAdd && <AddScraper api={api} registry={registry} onDone={() => { setShowAdd(false); load(); }} />}

      {scrapers.length === 0 ? (
        <p className="text-gray-400 text-center py-10">No scrapers configured. Add one to start sourcing leads.</p>
      ) : (
        <div className="grid gap-4">
          {scrapers.map(s => (
            <ScraperCard key={s.id} scraper={s} api={api} onRefresh={load} />
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Available Scraper Types</h2>
        <div className="grid gap-3">
          {registry.map(r => (
            <div key={r.type} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
              <div className="text-2xl">🔍</div>
              <div>
                <p className="font-medium text-gray-900">{r.name}</p>
                <p className="text-sm text-gray-500">{r.description}</p>
                <p className="text-xs text-gray-400 mt-1 font-mono">{r.type}</p>
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
      // Poll for status change
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
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-gray-900">{scraper.name}</h3>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[scraper.status] || STATUS_COLORS.idle}`}>
              {scraper.status}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1 font-mono">{scraper.type}</p>
          <div className="flex gap-6 mt-3 text-sm text-gray-600">
            <span>Tag: <strong>{scraper.campaign_tag}</strong></span>
            <span>Last run: <strong>{lastRun}</strong></span>
            <span>Total leads: <strong>{scraper.total_leads || 0}</strong></span>
            <span>Runs: <strong>{scraper.run_count || 0}</strong></span>
            {scraper.last_run_leads > 0 && (
              <span>Last batch: <strong>{scraper.last_run_leads}</strong></span>
            )}
          </div>
          {scraper.last_error && (
            <p className="text-xs text-red-500 mt-2">Error: {scraper.last_error}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadRuns}
            className="px-3 py-1.5 text-sm text-gray-600 bg-gray-50 rounded-lg hover:bg-gray-100"
          >
            History
          </button>
          <button
            onClick={runScraper}
            disabled={running || scraper.status === 'running'}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg ${
              running || scraper.status === 'running'
                ? 'bg-gray-200 text-gray-500 cursor-wait'
                : 'bg-green-50 text-green-700 hover:bg-green-100'
            }`}
          >
            {running || scraper.status === 'running' ? 'Running...' : '▶ Run'}
          </button>
          <button
            onClick={deleteScraper}
            className="px-3 py-1.5 text-sm text-red-500 bg-red-50 rounded-lg hover:bg-red-100"
          >
            ✕
          </button>
        </div>
      </div>

      {expanded && runs && (
        <div className="mt-4 border-t pt-3">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Run History</h4>
          {runs.length === 0 ? (
            <p className="text-sm text-gray-400">No runs yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 text-xs">
                  <th className="pb-1">Date</th>
                  <th className="pb-1">Raw</th>
                  <th className="pb-1">Firms</th>
                  <th className="pb-1">Ingested</th>
                  <th className="pb-1">Duration</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="border-t border-gray-50">
                    <td className="py-1.5">
                      {new Date(r.created_at._seconds ? r.created_at._seconds * 1000 : r.created_at).toLocaleString()}
                    </td>
                    <td>{r.total_raw}</td>
                    <td>{r.unique_firms}</td>
                    <td className="font-medium">{r.leads_ingested}</td>
                    <td>{r.duration_seconds}s</td>
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
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h3 className="font-semibold text-gray-900 mb-4">New Scraper</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g., FL Political Consultants"
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Type</label>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          >
            {registry.map(r => (
              <option key={r.type} value={r.type}>{r.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Campaign Tag</label>
          <input
            type="text"
            value={tag}
            onChange={e => setTag(e.target.value)}
            placeholder={`${type}-leads`}
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>
      {selected && (
        <p className="text-sm text-gray-500 mt-3">{selected.description}</p>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onDone} className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 rounded-lg">Cancel</button>
        <button
          onClick={save}
          disabled={saving || !name}
          className="px-4 py-2 text-sm font-medium bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Create Scraper'}
        </button>
      </div>
    </div>
  );
}

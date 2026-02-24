import { useState, useEffect } from 'react';

const STATUS_COLORS = {
  ingested: 'bg-gray-100 text-gray-700',
  enriched: 'bg-blue-100 text-blue-700',
  scored: 'bg-indigo-100 text-indigo-700',
  emailed: 'bg-purple-100 text-purple-700',
  replied: 'bg-green-100 text-green-700',
  booked: 'bg-emerald-100 text-emerald-700',
  dead: 'bg-red-100 text-red-700',
  enriching: 'bg-yellow-100 text-yellow-700',
  enrichment_failed: 'bg-red-100 text-red-700',
};

const TIER_COLORS = {
  priority: 'bg-red-100 text-red-700',
  standard: 'bg-blue-100 text-blue-700',
  nurture: 'bg-gray-100 text-gray-700',
  manual_review: 'bg-yellow-100 text-yellow-700',
};

function Badge({ text, colorMap }) {
  const cls = colorMap?.[text] || 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {text || '—'}
    </span>
  );
}

export default function Leads({ api }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', tier: '' });

  const fetchLeads = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.tier) params.set('tier', filter.tier);
    params.set('limit', '100');

    fetch(`${api}/api/leads?${params}`)
      .then(r => r.json())
      .then(d => { setLeads(d.leads || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(fetchLeads, [api, filter.status, filter.tier]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
        <div className="flex gap-2">
          <select
            value={filter.status}
            onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Statuses</option>
            {Object.keys(STATUS_COLORS).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={filter.tier}
            onChange={e => setFilter(f => ({ ...f, tier: e.target.value }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Tiers</option>
            <option value="priority">Priority</option>
            <option value="standard">Standard</option>
            <option value="nurture">Nurture</option>
            <option value="manual_review">Manual Review</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <p className="text-gray-400 py-10 text-center">Loading...</p>
        ) : leads.length === 0 ? (
          <p className="text-gray-400 py-10 text-center">No leads found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-500 text-xs uppercase tracking-wide">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Tier</th>
                  <th className="px-4 py-3">Signal</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leads.map(lead => (
                  <tr key={lead.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {lead.first_name} {lead.last_name}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{lead.company_name}</td>
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{lead.email}</td>
                    <td className="px-4 py-3 text-gray-600">{lead.role_title}</td>
                    <td className="px-4 py-3 font-semibold">{lead.score ?? '—'}</td>
                    <td className="px-4 py-3"><Badge text={lead.tier} colorMap={TIER_COLORS} /></td>
                    <td className="px-4 py-3 text-xs text-gray-500">{lead.signal_type || '—'}</td>
                    <td className="px-4 py-3"><Badge text={lead.status} colorMap={STATUS_COLORS} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

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

function formatMoney(n) {
  if (!n && n !== 0) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function ExpenditureDetail({ lead }) {
  const cf = lead.custom_fields || {};
  const expenditures = cf.expenditures || [];
  const hasDetail = expenditures.length > 0 || cf.total_campaign_spend || cf.purposes;

  if (!hasDetail) {
    return <p className="text-gray-400 text-xs italic py-2">No expenditure data available</p>;
  }

  return (
    <div className="space-y-3">
      {/* Full legal name if different from display */}
      {lead.company_display && lead.company_name && lead.company_display !== lead.company_name && (
        <div className="text-xs text-gray-400">Legal name: {lead.company_name}</div>
      )}

      {/* Summary stats */}
      <div className="flex flex-wrap gap-4 text-sm">
        {cf.total_campaign_spend > 0 && (
          <div>
            <span className="text-gray-500">Total Spend:</span>{' '}
            <span className="font-semibold text-green-700">{formatMoney(cf.total_campaign_spend)}</span>
          </div>
        )}
        {cf.expenditure_count > 0 && (
          <div>
            <span className="text-gray-500">Payments:</span>{' '}
            <span className="font-semibold">{cf.expenditure_count}</span>
          </div>
        )}
        {cf.purposes && (
          <div>
            <span className="text-gray-500">Services:</span>{' '}
            <span className="font-medium">{cf.purposes}</span>
          </div>
        )}
        {(cf.city || cf.state) && (
          <div>
            <span className="text-gray-500">Location:</span>{' '}
            <span>{[cf.city, cf.state].filter(Boolean).join(', ')}</span>
          </div>
        )}
        {cf.parties_served && (
          <div>
            <span className="text-gray-500">Parties:</span>{' '}
            <span className="font-medium">{cf.parties_served}</span>
          </div>
        )}
      </div>

      {/* Contact info if enriched */}
      {(lead.first_name || lead.email || lead.linkedin_url) && (
        <div className="flex flex-wrap gap-4 text-sm bg-blue-50 rounded-lg px-3 py-2">
          {(lead.first_name || lead.last_name) && (
            <div>
              <span className="text-gray-500">Contact:</span>{' '}
              <span className="font-medium">{lead.first_name} {lead.last_name}</span>
              {lead.role_title && <span className="text-gray-500 ml-1">({lead.role_title})</span>}
            </div>
          )}
          {lead.email && (
            <div>
              <span className="text-gray-500">Email:</span>{' '}
              <a href={`mailto:${lead.email}`} className="text-blue-600 hover:underline font-mono text-xs">{lead.email}</a>
            </div>
          )}
          {lead.linkedin_url && (
            <div>
              <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">LinkedIn</a>
            </div>
          )}
          {lead.company_domain && (
            <div>
              <span className="text-gray-500">Website:</span>{' '}
              <a href={`https://${lead.company_domain}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">{lead.company_domain}</a>
            </div>
          )}
        </div>
      )}

      {/* Candidates served */}
      {cf.candidates_served && (
        <div className="text-sm">
          <span className="text-gray-500">Candidates Served:</span>{' '}
          <span className="text-gray-700">{cf.candidates_served}</span>
        </div>
      )}

      {/* Expenditure table */}
      {expenditures.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-100 text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 text-left">Candidate / Committee</th>
                <th className="px-3 py-2 text-left">Party</th>
                <th className="px-3 py-2 text-left">Purpose</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {expenditures.map((exp, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5 text-gray-800">{exp.candidate_display || exp.candidate || '—'}</td>
                  <td className="px-3 py-1.5">
                    {exp.party ? (
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                        exp.party === 'Republican' ? 'bg-red-100 text-red-700' :
                        exp.party === 'Democrat' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-600'
                      }`}>{exp.party}</span>
                    ) : <span className="text-gray-400">{exp.type || '—'}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600">{exp.purpose || '—'}</td>
                  <td className="px-3 py-1.5 text-gray-500 text-xs">{exp.date || '—'}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-green-700">{formatMoney(exp.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Leads({ api }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', tier: '', source: '' });
  const [expandedId, setExpandedId] = useState(null);

  const fetchLeads = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.tier) params.set('tier', filter.tier);
    params.set('limit', '200');

    fetch(`${api}/api/leads?${params}`)
      .then(r => r.json())
      .then(d => {
        let list = d.leads || [];
        if (filter.source) list = list.filter(l => l.source === filter.source);
        setLeads(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(fetchLeads, [api, filter.status, filter.tier, filter.source]);

  const sources = [...new Set(leads.map(l => l.source).filter(Boolean))];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
        <div className="flex gap-2 flex-wrap">
          <select
            value={filter.source}
            onChange={e => setFilter(f => ({ ...f, source: e.target.value }))}
            className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Sources</option>
            {sources.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
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
                  <th className="px-4 py-3 w-8"></th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Party</th>
                  <th className="px-4 py-3">Total Spend</th>
                  <th className="px-4 py-3">Payments</th>
                  <th className="px-4 py-3">Services</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leads.map(lead => {
                  const cf = lead.custom_fields || {};
                  const isExpanded = expandedId === lead.id;
                  return (
                    <>
                      <tr
                        key={lead.id}
                        className={`hover:bg-gray-50 transition-colors cursor-pointer ${isExpanded ? 'bg-blue-50' : ''}`}
                        onClick={() => setExpandedId(isExpanded ? null : lead.id)}
                      >
                        <td className="px-4 py-3 text-gray-400">
                          <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">{lead.company_display || lead.company_name || '—'}</td>
                        <td className="px-4 py-3 text-gray-600">
                          {lead.first_name || lead.last_name
                            ? `${lead.first_name} ${lead.last_name}`.trim()
                            : <span className="text-gray-400 italic">No contact</span>}
                        </td>
                        <td className="px-4 py-3">
                          {cf.parties_served ? (
                            <span className="text-xs">
                              {cf.parties_served.split(', ').map((p, i) => (
                                <span key={i} className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium mr-1 ${
                                  p === 'Republican' ? 'bg-red-100 text-red-700' :
                                  p === 'Democrat' ? 'bg-blue-100 text-blue-700' :
                                  'bg-gray-100 text-gray-600'
                                }`}>{p}</span>
                              ))}
                            </span>
                          ) : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-3 font-semibold text-green-700">
                          {cf.total_campaign_spend ? formatMoney(cf.total_campaign_spend) : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{cf.expenditure_count || '—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate">{cf.purposes || '—'}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">{lead.source || '—'}</td>
                        <td className="px-4 py-3"><Badge text={lead.status} colorMap={STATUS_COLORS} /></td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${lead.id}-detail`}>
                          <td colSpan={10} className="px-6 py-4 bg-gray-50 border-t border-gray-200">
                            <ExpenditureDetail lead={lead} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!loading && leads.length > 0 && (
          <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-xs text-gray-500">
            Showing {leads.length} leads
          </div>
        )}
      </div>
    </div>
  );
}

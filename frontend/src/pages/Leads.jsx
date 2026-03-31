import { useState, useEffect } from 'react';

const STATUS_COLORS = {
  ingested: 'bg-white/10 text-white/60',
  enriched: 'bg-blue-500/15 text-blue-400',
  scored: 'bg-indigo-500/15 text-indigo-400',
  emailed: 'bg-purple-500/15 text-purple-400',
  replied: 'bg-green-500/15 text-green-400',
  booked: 'bg-emerald-500/15 text-emerald-400',
  dead: 'bg-red-500/15 text-red-400',
  enriching: 'bg-yellow-500/15 text-yellow-400',
  enrichment_failed: 'bg-red-500/15 text-red-400',
};

const TIER_COLORS = {
  priority: 'bg-red-500/15 text-red-400',
  standard: 'bg-blue-500/15 text-blue-400',
  nurture: 'bg-white/10 text-white/50',
  manual_review: 'bg-yellow-500/15 text-yellow-400',
};

function Badge({ text, colorMap }) {
  const cls = colorMap?.[text] || 'bg-white/10 text-white/50';
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-lg text-xs font-medium border border-white/5 ${cls}`}>
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
    return <p className="text-white/20 text-xs italic py-2">No expenditure data available</p>;
  }

  return (
    <div className="space-y-3">
      {lead.company_display && lead.company_name && lead.company_display !== lead.company_name && (
        <div className="text-xs text-white/30">Legal name: {lead.company_name}</div>
      )}

      <div className="flex flex-wrap gap-4 text-sm">
        {cf.total_campaign_spend > 0 && (
          <div>
            <span className="text-white/40">Total Spend:</span>{' '}
            <span className="font-semibold text-emerald-400">{formatMoney(cf.total_campaign_spend)}</span>
          </div>
        )}
        {cf.expenditure_count > 0 && (
          <div>
            <span className="text-white/40">Payments:</span>{' '}
            <span className="font-semibold text-white/80">{cf.expenditure_count}</span>
          </div>
        )}
        {cf.purposes && (
          <div>
            <span className="text-white/40">Services:</span>{' '}
            <span className="font-medium text-white/70">{cf.purposes}</span>
          </div>
        )}
        {(cf.city || cf.state) && (
          <div>
            <span className="text-white/40">Location:</span>{' '}
            <span className="text-white/70">{[cf.city, cf.state].filter(Boolean).join(', ')}</span>
          </div>
        )}
        {cf.parties_served && (
          <div>
            <span className="text-white/40">Parties:</span>{' '}
            <span className="font-medium text-white/70">{cf.parties_served}</span>
          </div>
        )}
      </div>

      {(lead.first_name || lead.email || lead.linkedin_url) && (
        <div className="flex flex-wrap gap-4 text-sm bg-brand-500/10 border border-brand-500/15 rounded-xl px-3 py-2">
          {(lead.first_name || lead.last_name) && (
            <div>
              <span className="text-white/40">Contact:</span>{' '}
              <span className="font-medium text-white/80">{lead.first_name} {lead.last_name}</span>
              {lead.role_title && <span className="text-white/40 ml-1">({lead.role_title})</span>}
            </div>
          )}
          {lead.email && (
            <div>
              <span className="text-white/40">Email:</span>{' '}
              <a href={`mailto:${lead.email}`} className="text-brand-400 hover:text-brand-300 font-mono text-xs">{lead.email}</a>
            </div>
          )}
          {lead.linkedin_url && (
            <div>
              <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:text-brand-300 text-xs">LinkedIn</a>
            </div>
          )}
          {lead.company_domain && (
            <div>
              <span className="text-white/40">Website:</span>{' '}
              <a href={`https://${lead.company_domain}`} target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:text-brand-300 text-xs">{lead.company_domain}</a>
            </div>
          )}
        </div>
      )}

      {cf.candidates_served && (
        <div className="text-sm">
          <span className="text-white/40">Candidates Served:</span>{' '}
          <span className="text-white/60">{cf.candidates_served}</span>
        </div>
      )}

      {expenditures.length > 0 && (
        <div className="border border-white/10 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/5 text-white/40 uppercase tracking-wide">
                <th className="px-3 py-2 text-left">Candidate / Committee</th>
                <th className="px-3 py-2 text-left">Party</th>
                <th className="px-3 py-2 text-left">Purpose</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {expenditures.map((exp, i) => (
                <tr key={i} className="hover:bg-white/5 transition-colors">
                  <td className="px-3 py-1.5 text-white/70">{exp.candidate_display || exp.candidate || '—'}</td>
                  <td className="px-3 py-1.5">
                    {exp.party ? (
                      <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                        exp.party === 'Republican' ? 'bg-red-500/15 text-red-400' :
                        exp.party === 'Democrat' ? 'bg-blue-500/15 text-blue-400' :
                        'bg-white/10 text-white/50'
                      }`}>{exp.party}</span>
                    ) : <span className="text-white/30">{exp.type || '—'}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-white/50">{exp.purpose || '—'}</td>
                  <td className="px-3 py-1.5 text-white/40 text-xs">{exp.date || '—'}</td>
                  <td className="px-3 py-1.5 text-right font-medium text-emerald-400">{formatMoney(exp.amount)}</td>
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

  const exportCSV = () => {
    if (!leads.length) return;
    const headers = [
      'Company', 'Legal Name', 'First Name', 'Last Name', 'Title',
      'Email', 'LinkedIn', 'Website', 'Party', 'Total Spend',
      'Payments', 'Services', 'Candidates Served', 'City', 'State',
      'Source', 'Status', 'Tier', 'Score', 'Signal'
    ];
    const esc = v => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = leads.map(l => {
      const cf = l.custom_fields || {};
      return [
        l.company_display || l.company_name || '',
        l.company_name || '',
        l.first_name || '',
        l.last_name || '',
        l.role_title || '',
        l.email || '',
        l.linkedin_url || '',
        l.company_domain || '',
        cf.parties_served || '',
        cf.total_campaign_spend || '',
        cf.expenditure_count || '',
        cf.purposes || '',
        cf.candidates_served || '',
        cf.city || '',
        cf.state || '',
        l.source || '',
        l.status || '',
        l.tier || '',
        l.score ?? '',
        l.signal_type || '',
      ].map(esc).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-white">Leads</h1>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={exportCSV}
            disabled={!leads.length}
            className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 text-sm font-medium rounded-xl border border-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Export CSV
          </button>
          <select
            value={filter.source}
            onChange={e => setFilter(f => ({ ...f, source: e.target.value }))}
            className="glass-input rounded-xl px-3 py-1.5 text-sm"
          >
            <option value="">All Sources</option>
            {sources.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={filter.status}
            onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}
            className="glass-input rounded-xl px-3 py-1.5 text-sm"
          >
            <option value="">All Statuses</option>
            {Object.keys(STATUS_COLORS).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={filter.tier}
            onChange={e => setFilter(f => ({ ...f, tier: e.target.value }))}
            className="glass-input rounded-xl px-3 py-1.5 text-sm"
          >
            <option value="">All Tiers</option>
            <option value="priority">Priority</option>
            <option value="standard">Standard</option>
            <option value="nurture">Nurture</option>
            <option value="manual_review">Manual Review</option>
          </select>
        </div>
      </div>

      <div className="glass-card rounded-2xl overflow-hidden">
        {loading ? (
          <p className="text-white/30 py-10 text-center">Loading...</p>
        ) : leads.length === 0 ? (
          <p className="text-white/30 py-10 text-center">No leads found</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/5 text-left text-white/40 text-xs uppercase tracking-wide">
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
              <tbody className="divide-y divide-white/5">
                {leads.map(lead => {
                  const cf = lead.custom_fields || {};
                  const isExpanded = expandedId === lead.id;
                  return (
                    <>
                      <tr
                        key={lead.id}
                        className={`hover:bg-white/5 transition-colors cursor-pointer ${isExpanded ? 'bg-brand-500/10' : ''}`}
                        onClick={() => setExpandedId(isExpanded ? null : lead.id)}
                      >
                        <td className="px-4 py-3 text-white/30">
                          <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                        </td>
                        <td className="px-4 py-3 font-medium text-white/90">{lead.company_display || lead.company_name || '—'}</td>
                        <td className="px-4 py-3 text-white/60">
                          {lead.first_name || lead.last_name
                            ? `${lead.first_name} ${lead.last_name}`.trim()
                            : <span className="text-white/20 italic">No contact</span>}
                        </td>
                        <td className="px-4 py-3">
                          {cf.parties_served ? (
                            <span className="text-xs">
                              {cf.parties_served.split(', ').map((p, i) => (
                                <span key={i} className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium mr-1 ${
                                  p === 'Republican' ? 'bg-red-500/15 text-red-400' :
                                  p === 'Democrat' ? 'bg-blue-500/15 text-blue-400' :
                                  'bg-white/10 text-white/50'
                                }`}>{p}</span>
                              ))}
                            </span>
                          ) : <span className="text-white/20">—</span>}
                        </td>
                        <td className="px-4 py-3 font-semibold text-emerald-400">
                          {cf.total_campaign_spend ? formatMoney(cf.total_campaign_spend) : '—'}
                        </td>
                        <td className="px-4 py-3 text-white/50">{cf.expenditure_count || '—'}</td>
                        <td className="px-4 py-3 text-xs text-white/40 max-w-[200px] truncate">{cf.purposes || '—'}</td>
                        <td className="px-4 py-3 text-xs text-white/40">{lead.source || '—'}</td>
                        <td className="px-4 py-3"><Badge text={lead.status} colorMap={STATUS_COLORS} /></td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${lead.id}-detail`}>
                          <td colSpan={10} className="px-6 py-4 bg-white/3 border-t border-white/5">
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
          <div className="px-4 py-3 bg-white/3 border-t border-white/5 text-xs text-white/30">
            Showing {leads.length} leads
          </div>
        )}
      </div>
    </div>
  );
}

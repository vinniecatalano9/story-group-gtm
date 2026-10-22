import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FunnelStats } from '../pages/AdLeads';

// Main page card (Vincent, 10/22): the Ad Leads funnel stats, always on the
// home route, with a link to the full page. Open times: components/OpenTimes.jsx.

export { OpenTimes } from './OpenTimes';

export function AdLeadsSummary({ api }) {
  const [leads, setLeads] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch(`${api}/api/cadence/leads`).then(r => r.json()).then(d => (d.leads ? setLeads(d.leads) : setErr(d.error || 'No data'))).catch(e => setErr(e.message));
  }, [api]);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-serif text-xl font-bold text-body">Ad Leads</h2>
        <Link to="/ad-leads" className="text-sm font-semibold text-brand-400 hover:text-brand-300">Open Ad Leads page</Link>
      </div>
      {err ? <p className="text-sm text-red-300">Couldn't load ad leads: {err}</p>
        : !leads ? <p className="text-sm text-muted">Loading...</p>
        : <FunnelStats leads={leads} />}
    </div>
  );
}

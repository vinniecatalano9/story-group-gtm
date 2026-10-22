import { useState, useEffect } from 'react';

// Vincent's call times that are free and not yet offered to anyone (10/22),
// plus who each promised time is held for and whether that lead is his
// (GET /api/cadence/open-times, the same windows and holds the cadence uses).
// On the main page and the Ad Leads page.

const clock = (v, tz) => new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).replace(' ', '').toLowerCase();
const both = (v) => `${clock(v, 'America/Chicago')} CT (${clock(v, 'America/New_York')} ET)`;
const dayOf = (v) => new Date(v).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
const whose = (w) => (w.mine ? 'yours' : w.rep ? `${w.rep}'s` : 'no rep set');

export function OpenTimes({ api }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = () => {
    setErr('');
    fetch(`${api}/api/cadence/open-times?days=5`).then(r => r.json()).then(d => (d.days ? setData(d) : setErr(d.error || 'No data'))).catch(e => setErr(e.message));
  };
  useEffect(load, [api]);

  const promisedByDay = {};
  for (const p of (data && data.promised) || []) (promisedByDay[dayOf(p.start)] ||= []).push(p);
  const openCount = data ? data.days.reduce((n, d) => n + d.open.length, 0) : 0;

  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-serif text-xl font-bold text-body">Vincent: times not promised yet</h2>
          <p className="text-muted text-xs mt-1">30 min slots, 10 to 12 and 2 to 5 ET, today plus the next 5 business days. Free on your calendar and not offered to any lead.</p>
        </div>
        <button onClick={load} className="text-sm font-semibold text-brand-400 hover:text-brand-300">Refresh</button>
      </div>
      {err && <p className="text-sm text-red-300 mt-3">Couldn't load times: {err}</p>}
      {data && data.unreadable.length > 0 && <p className="text-sm text-yellow-300 mt-3">Couldn't read calendar {data.unreadable.join(', ')}, so these may be wrong.</p>}
      {!data && !err && <p className="text-sm text-muted mt-3">Loading...</p>}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
          <div>
            <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.12em] mb-2">Open ({openCount})</p>
            <div className="space-y-2">
              {data.days.map(d => (
                <div key={d.date}>
                  <p className="text-sm font-semibold text-body">{d.label}</p>
                  <p className="text-sm text-muted">{d.open.length ? d.open.map(both).join(', ') : 'nothing open'}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.12em] mb-2">Promised ({data.promised.length})</p>
            {data.promised.length === 0 ? <p className="text-sm text-muted">Nothing offered yet.</p> : (
              <div className="space-y-2">
                {Object.entries(promisedByDay).map(([day, list]) => (
                  <div key={day}>
                    <p className="text-sm font-semibold text-body">{day}</p>
                    {list.map(p => (
                      <p key={p.start} className="text-sm text-muted">
                        {both(p.start)}: {(p.who || p.names.map(name => ({ name }))).map((w, i) => (
                          <span key={w.name}>{i ? ', ' : ''}{w.name}{' '}
                            <span className={w.mine ? 'text-green-500 font-semibold' : 'text-yellow-600 font-semibold'}>({whose(w)}{w.source === 'linkedin' ? ', LinkedIn' : ''})</span>
                          </span>
                        ))}{p.on_calendar ? ', on your calendar now' : ''}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

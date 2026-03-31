import { useState, useEffect } from 'react';

function formatDuration(minutes) {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  return `${h}h ${minutes % 60}m`;
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Transcripts({ api }) {
  const [transcripts, setTranscripts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [filter, setFilter] = useState('all'); // all, matched, unmatched

  const fetchTranscripts = () => {
    setLoading(true);
    fetch(`${api}/api/fireflies/transcripts?limit=50`)
      .then(r => r.json())
      .then(d => { setTranscripts(d.transcripts || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { fetchTranscripts(); }, [api]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      await fetch(`${api}/api/fireflies/sync`, { method: 'POST' });
      fetchTranscripts();
    } catch { /* ignore */ }
    setSyncing(false);
  };

  const filtered = transcripts.filter(t => {
    if (filter === 'matched') return t.matched_contacts?.length > 0;
    if (filter === 'unmatched') return !t.matched_contacts?.length;
    return true;
  });

  const matchedCount = transcripts.filter(t => t.matched_contacts?.length > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-white">Call Transcripts</h1>
          <span className="text-sm text-white/30">{transcripts.length} total</span>
          {matchedCount > 0 && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-lg bg-green-500/15 text-green-400 border border-green-500/20">
              {matchedCount} matched to contacts
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="glass-input rounded-xl px-3 py-1.5 text-sm"
          >
            <option value="all">All Transcripts</option>
            <option value="matched">Matched to Contacts</option>
            <option value="unmatched">Unmatched</option>
          </select>
          <button
            onClick={syncNow}
            disabled={syncing}
            className="glass-btn-primary px-4 py-1.5 text-sm rounded-xl disabled:opacity-50"
          >
            {syncing ? 'Syncing...' : 'Sync & Match'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-white/30 py-10 text-center">Loading transcripts from Fireflies...</p>
      ) : filtered.length === 0 ? (
        <p className="text-white/30 py-10 text-center">
          {filter !== 'all' ? 'No transcripts match this filter' : 'No transcripts found'}
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map(t => {
            const isExpanded = expanded === t.id;
            const hasMatch = t.matched_contacts?.length > 0;
            return (
              <div
                key={t.id}
                className={`glass-card rounded-2xl border ${hasMatch ? 'border-green-500/20' : 'border-white/5'} overflow-hidden`}
              >
                <div
                  className="p-5 cursor-pointer hover:bg-white/[0.02] transition-all"
                  onClick={() => setExpanded(isExpanded ? null : t.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <span className="text-lg">🎙️</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-white/90 truncate">{t.title || 'Untitled Meeting'}</span>
                          {hasMatch && (
                            <span className="px-2 py-0.5 rounded-lg text-xs font-medium bg-green-500/15 text-green-400 border border-green-500/20">
                              {t.matched_contacts.length} contact{t.matched_contacts.length > 1 ? 's' : ''} matched
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-white/40">
                          {t.date && <span>{formatDate(t.date)}</span>}
                          {t.duration && <span>{formatDuration(t.duration)}</span>}
                          {t.participants?.length > 0 && (
                            <span>{t.participants.length} participant{t.participants.length > 1 ? 's' : ''}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {t.transcript_url && (
                        <a
                          href={t.transcript_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-3 py-1.5 text-xs font-medium rounded-xl border border-brand-500/20 text-brand-400 bg-brand-500/10 hover:bg-brand-500/20 transition-all"
                          onClick={e => e.stopPropagation()}
                        >
                          View ↗
                        </a>
                      )}
                      <span className="text-white/20 text-sm">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-white/5 p-5 space-y-4">
                    {/* Matched contacts */}
                    {hasMatch && (
                      <div>
                        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-2">Matched Contacts</p>
                        <div className="flex flex-wrap gap-2">
                          {t.matched_contacts.map((c, i) => (
                            <span key={i} className="px-3 py-1.5 rounded-xl text-sm bg-green-500/10 text-green-400 border border-green-500/20">
                              {c.email} <span className="text-green-400/50">({c.source})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Participants */}
                    {t.participants?.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-2">Participants</p>
                        <div className="flex flex-wrap gap-2">
                          {t.participants.map((p, i) => (
                            <span key={i} className="px-2.5 py-1 rounded-lg text-xs bg-white/5 text-white/60 border border-white/10">
                              {p}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Overview */}
                    {t.overview && (
                      <div>
                        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-2">Summary</p>
                        <p className="text-sm text-white/60 bg-white/5 rounded-xl p-3 border border-white/5">{t.overview}</p>
                      </div>
                    )}

                    {/* Action items */}
                    {t.action_items && (
                      <div>
                        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-2">Action Items</p>
                        <p className="text-sm text-white/60 bg-amber-500/5 rounded-xl p-3 border border-amber-500/10">{t.action_items}</p>
                      </div>
                    )}

                    {/* Keywords */}
                    {t.keywords && (
                      <div>
                        <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-2">Keywords</p>
                        <div className="flex flex-wrap gap-1.5">
                          {(Array.isArray(t.keywords) ? t.keywords : t.keywords.split(',')).map((k, i) => (
                            <span key={i} className="px-2 py-0.5 rounded-lg text-xs bg-brand-500/10 text-brand-400 border border-brand-500/20">
                              {k.trim()}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';

const CLASS_COLORS = {
  interested: 'bg-green-500/15 text-green-400 border-green-500/20',
  why_reach_out: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  more_info: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  cost_question: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  question_other: 'bg-white/10 text-white/50 border-white/10',
  referral: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  re_engage: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  other: 'bg-white/10 text-white/50 border-white/10',
};

const CLASS_EMOJI = {
  interested: '🔥',
  why_reach_out: '❓',
  more_info: 'ℹ️',
  cost_question: '💰',
  referral: '🤝',
  re_engage: '🔄',
  other: '💬',
};

function formatTime(created_at) {
  if (!created_at) return '';
  if (created_at?._seconds) return new Date(created_at._seconds * 1000).toLocaleString();
  return new Date(created_at).toLocaleString();
}

function formatDate(d) {
  if (!d) return '';
  if (d?._seconds) return new Date(d._seconds * 1000).toLocaleDateString();
  return new Date(d).toLocaleDateString();
}

// Conversation Thread Modal
function ThreadModal({ email, api, onClose }) {
  const [thread, setThread] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${api}/api/replies/thread/${encodeURIComponent(email)}`)
      .then(r => r.json())
      .then(d => { setThread(d.thread || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [api, email]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/10">
          <div>
            <h2 className="text-lg font-bold text-white">Conversation Thread</h2>
            <p className="text-sm text-white/40">{email} · {thread.length} messages</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60 text-xl px-2">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <p className="text-white/30 text-center py-10">Loading thread...</p>
          ) : thread.length === 0 ? (
            <p className="text-white/30 text-center py-10">No messages found</p>
          ) : (
            thread.map((msg, i) => {
              const cls = msg.classification || 'other';
              const colors = CLASS_COLORS[cls] || CLASS_COLORS.other;
              const time = formatTime(msg.created_at);
              return (
                <div key={msg.id || i} className="space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`px-2 py-0.5 rounded-lg font-medium ${colors}`}>{cls.replace(/_/g, ' ')}</span>
                    <span className="text-white/30">{time}</span>
                    {msg.handled && <span className="text-green-400/60">✓ handled</span>}
                    {msg.had_meeting && <span className="text-blue-400/60">📅 met</span>}
                    {msg.second_call_booked && <span className="text-purple-400/60">📞 2nd call</span>}
                    {msg.closed_deal && <span className="text-green-400/60">💰 closed</span>}
                  </div>
                  <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                    <p className="text-sm text-white/60 italic">"{msg.reply_text}"</p>
                  </div>
                  {msg.sent_response && (
                    <div className="bg-brand-500/10 rounded-xl p-3 border border-brand-500/15 ml-8">
                      <p className="text-xs text-white/30 mb-1">Our reply:</p>
                      <p className="text-sm text-brand-300">{msg.sent_response}</p>
                    </div>
                  )}
                  {msg.summary && msg.summary !== 'Classification failed' && (
                    <p className="text-xs text-white/40 ml-2">{msg.summary}</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ReplyCard({ reply, api, onHandled, onUpdated }) {
  const [marking, setMarking] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [showThread, setShowThread] = useState(false);
  const [showTracking, setShowTracking] = useState(false);
  const [replyText, setReplyText] = useState(reply.draft_response || '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSubseq, setShowSubseq] = useState(false);
  const [subsequences, setSubsequences] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [selectedSub, setSelectedSub] = useState('');
  const [addingSub, setAddingSub] = useState(false);

  // Tracking state
  const [hadMeeting, setHadMeeting] = useState(reply.had_meeting || false);
  const [secondCallBooked, setSecondCallBooked] = useState(reply.second_call_booked || false);
  const [closedDeal, setClosedDeal] = useState(reply.closed_deal || false);
  const [followUpDate, setFollowUpDate] = useState(reply.follow_up_date || '');
  const [notes, setNotes] = useState(reply.notes || '');

  const cls = reply.classification || 'other';
  const colors = CLASS_COLORS[cls] || CLASS_COLORS.other;
  const emoji = CLASS_EMOJI[cls] || '💬';
  const time = formatTime(reply.created_at);
  const canReply = reply.email_uuid && reply.eaccount;
  const borderColor = colors.split(' ')[2] || 'border-white/10';

  const markDone = async () => {
    setMarking(true);
    try {
      await fetch(`${api}/api/replies/${reply.id}/handled`, { method: 'PATCH' });
      onHandled(reply.id);
    } catch {
      setMarking(false);
    }
  };

  const sendReply = async () => {
    if (!replyText.trim() || !canReply) return;
    setSending(true);
    try {
      const res = await fetch(`${api}/api/instantly/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_uuid: reply.email_uuid,
          eaccount: reply.eaccount,
          message: replyText.trim(),
          // Don't pass reply_id — we mark handled after subsequence step
        }),
      });
      if (res.ok) {
        setSent(true);
        setShowSubseq(true);
        // Fetch subsequences
        setLoadingSubs(true);
        fetch(`${api}/api/instantly/subsequences`)
          .then(r => r.json())
          .then(d => {
            const allSubs = [];
            if (d.campaigns) {
              Object.entries(d.campaigns).forEach(([name, info]) => {
                (info.subsequences || []).forEach(s => {
                  allSubs.push({ ...s, campaign_name: name, campaign_id: info.campaign_id });
                });
              });
            }
            setSubsequences(allSubs);
            setLoadingSubs(false);
          })
          .catch(() => setLoadingSubs(false));
      } else {
        const err = await res.json();
        alert(`Send failed: ${err.error || 'Unknown error'}`);
        setSending(false);
      }
    } catch {
      alert('Send failed — check connection');
      setSending(false);
    }
  };

  const saveTracking = async () => {
    setSaving(true);
    try {
      await fetch(`${api}/api/replies/${reply.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          had_meeting: hadMeeting,
          second_call_booked: secondCallBooked,
          closed_deal: closedDeal,
          follow_up_date: followUpDate || null,
          notes: notes || null,
          meeting_date: hadMeeting && !reply.meeting_date ? new Date().toISOString() : reply.meeting_date || null,
          second_call_date: secondCallBooked && !reply.second_call_date ? new Date().toISOString() : reply.second_call_date || null,
          closed_date: closedDeal && !reply.closed_date ? new Date().toISOString() : reply.closed_date || null,
        }),
      });
      if (onUpdated) onUpdated(reply.id, { had_meeting: hadMeeting, second_call_booked: secondCallBooked, closed_deal: closedDeal, follow_up_date: followUpDate, notes });
      setSaving(false);
    } catch {
      alert('Failed to save');
      setSaving(false);
    }
  };

  const markHandledAndRemove = async () => {
    try {
      await fetch(`${api}/api/replies/${reply.id}/handled`, { method: 'PATCH' });
    } catch { /* best effort */ }
    onHandled(reply.id);
  };

  const addToSubsequence = async () => {
    if (!selectedSub) return;
    setAddingSub(true);
    try {
      const sub = subsequences.find(s => s.id === selectedSub);
      await fetch(`${api}/api/instantly/subsequence/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: reply.email,
          subsequence_id: selectedSub,
          campaign_id: sub?.campaign_id || null,
        }),
      });
      await markHandledAndRemove();
    } catch {
      alert('Failed to add to subsequence');
      setAddingSub(false);
    }
  };

  const skipSubseq = async () => {
    await markHandledAndRemove();
  };

  // Check if follow-up is overdue
  const isOverdue = followUpDate && new Date(followUpDate) < new Date() && !reply.handled;

  return (
    <>
      <div className={`glass-card glass-card-hover rounded-2xl border ${borderColor} p-5 space-y-3 ${isOverdue ? 'ring-1 ring-amber-500/30' : ''}`}>
        <div className="flex items-start justify-between">
          <div className="flex items-center flex-wrap gap-2">
            <span className="text-lg">{emoji}</span>
            <span className="font-semibold text-white/90">{reply.email}</span>
            <span className={`inline-block px-2.5 py-0.5 rounded-lg text-xs font-medium ${colors}`}>
              {cls.replace(/_/g, ' ')}
            </span>
            {/* Tracking badges */}
            {hadMeeting && <span className="px-2 py-0.5 rounded-lg text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/20">📅 Met</span>}
            {secondCallBooked && <span className="px-2 py-0.5 rounded-lg text-xs font-medium bg-purple-500/15 text-purple-400 border border-purple-500/20">📞 2nd Call</span>}
            {closedDeal && <span className="px-2 py-0.5 rounded-lg text-xs font-medium bg-green-500/15 text-green-400 border border-green-500/20">💰 Closed</span>}
            {followUpDate && (
              <span className={`px-2 py-0.5 rounded-lg text-xs font-medium ${isOverdue ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20' : 'bg-white/5 text-white/40 border border-white/10'}`}>
                {isOverdue ? '⚠️' : '🔔'} Follow up {followUpDate}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-white/30">{time}</span>
            <button
              onClick={() => setShowThread(true)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-xl border border-white/10 text-white/40 bg-white/5 hover:bg-white/10 transition-all"
              title="View full conversation"
            >
              Thread
            </button>
            <button
              onClick={() => setShowTracking(!showTracking)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-xl border transition-all ${showTracking ? 'border-brand-500/30 text-brand-400 bg-brand-500/10' : 'border-white/10 text-white/40 bg-white/5 hover:bg-white/10'}`}
            >
              Track
            </button>
            {canReply && !sent && (
              <button
                onClick={() => setShowReply(!showReply)}
                className="px-2.5 py-1.5 text-xs font-medium rounded-xl border border-indigo-500/20 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 transition-all"
              >
                {showReply ? 'Close' : 'Reply'}
              </button>
            )}
            <button
              onClick={markDone}
              disabled={marking || sent}
              className="px-3 py-1.5 text-xs font-medium rounded-xl border border-green-500/20 text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-all disabled:opacity-50"
            >
              {sent ? 'Sent!' : marking ? '...' : 'Done'}
            </button>
          </div>
        </div>

        <p className="text-sm text-white/60 bg-white/5 rounded-xl p-3 italic border border-white/5">
          "{reply.reply_text?.substring(0, 300)}{reply.reply_text?.length > 300 ? '...' : ''}"
        </p>

        {reply.summary && reply.summary !== 'Classification failed' && (
          <p className="text-sm text-white/50">
            <span className="font-medium text-white/60">Summary:</span> {reply.summary}
          </p>
        )}

        {reply.draft_response && !showReply && (
          <div className="text-sm">
            <span className="font-medium text-white/50">Suggested Reply:</span>
            <p className="mt-1 bg-brand-500/10 border border-brand-500/15 rounded-xl p-3 text-brand-300">{reply.draft_response}</p>
          </div>
        )}

        {/* Tracking Panel */}
        {showTracking && (
          <div className="border-t border-white/10 pt-3 space-y-3">
            <p className="text-xs font-medium text-white/40 uppercase tracking-wide">Deal Tracking</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hadMeeting}
                  onChange={e => setHadMeeting(e.target.checked)}
                  className="rounded border-white/20 bg-white/5 text-blue-500"
                />
                <span className="text-sm text-white/60">Had Meeting</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={secondCallBooked}
                  onChange={e => setSecondCallBooked(e.target.checked)}
                  className="rounded border-white/20 bg-white/5 text-purple-500"
                />
                <span className="text-sm text-white/60">2nd Call Booked</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={closedDeal}
                  onChange={e => setClosedDeal(e.target.checked)}
                  className="rounded border-white/20 bg-white/5 text-green-500"
                />
                <span className="text-sm text-white/60">Closed Deal</span>
              </label>
              <div>
                <label className="text-xs text-white/40 block mb-1">Follow Up Date</label>
                <input
                  type="date"
                  value={followUpDate}
                  onChange={e => setFollowUpDate(e.target.value)}
                  className="glass-input rounded-lg px-2 py-1 text-sm w-full"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={saveTracking}
                  disabled={saving}
                  className="glass-btn-primary px-4 py-1.5 text-xs rounded-xl w-full disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-white/40 block mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={2}
                placeholder="Any notes about this lead..."
                className="glass-input w-full text-sm rounded-xl p-2 resize-y"
              />
            </div>
          </div>
        )}

        {/* Fireflies Transcripts */}
        {reply.transcripts?.length > 0 && (
          <div className="border-t border-white/10 pt-3 space-y-2">
            <p className="text-xs font-medium text-white/40 uppercase tracking-wide">🎙️ Call Transcripts</p>
            {reply.transcripts.map((t, i) => (
              <div key={t.fireflies_id || i} className="bg-white/5 rounded-xl p-3 border border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white/80">{t.title}</span>
                  <div className="flex items-center gap-2">
                    {t.duration && <span className="text-xs text-white/30">{t.duration}min</span>}
                    {t.date && <span className="text-xs text-white/30">{new Date(t.date).toLocaleDateString()}</span>}
                  </div>
                </div>
                {t.overview && <p className="text-xs text-white/50">{t.overview.substring(0, 200)}{t.overview.length > 200 ? '...' : ''}</p>}
                {t.action_items && <p className="text-xs text-white/40"><span className="font-medium text-white/50">Action items:</span> {t.action_items.substring(0, 150)}{t.action_items.length > 150 ? '...' : ''}</p>}
                <div className="flex gap-2">
                  {t.transcript_url && <a href={t.transcript_url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-400 hover:text-brand-300">View transcript ↗</a>}
                  {t.audio_url && <a href={t.audio_url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-400 hover:text-indigo-300">Audio ↗</a>}
                  {t.video_url && <a href={t.video_url} target="_blank" rel="noopener noreferrer" className="text-xs text-purple-400 hover:text-purple-300">Video ↗</a>}
                </div>
              </div>
            ))}
          </div>
        )}

        {showReply && (
          <div className="space-y-2 border-t border-white/10 pt-3">
            <p className="text-xs font-medium text-white/40 uppercase tracking-wide">Send Email Reply</p>
            <textarea
              value={replyText}
              onChange={e => setReplyText(e.target.value)}
              rows={5}
              className="glass-input w-full text-sm rounded-xl p-3 resize-y"
              placeholder="Type your reply..."
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/30">
                {replyText.length} chars · via {reply.eaccount}
              </span>
              <button
                onClick={sendReply}
                disabled={sending || !replyText.trim()}
                className="glass-btn-primary px-4 py-2 text-sm rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sending ? 'Sending...' : 'Send Email'}
              </button>
            </div>
          </div>
        )}

        {/* Subsequence Picker — shown after sending a reply */}
        {showSubseq && (
          <div className="space-y-2 border-t border-white/10 pt-3">
            <div className="flex items-center gap-2">
              <span className="text-green-400 text-sm font-medium">✓ Reply sent</span>
              <span className="text-white/30 text-xs">— Add to a subsequence?</span>
            </div>
            {loadingSubs ? (
              <p className="text-xs text-white/30">Loading subsequences...</p>
            ) : subsequences.length === 0 ? (
              <div className="flex items-center gap-2">
                <p className="text-xs text-white/30">No subsequences found</p>
                <button
                  onClick={skipSubseq}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-green-500/20 text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-all"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={selectedSub}
                  onChange={e => setSelectedSub(e.target.value)}
                  className="glass-input rounded-xl px-3 py-1.5 text-sm flex-1"
                >
                  <option value="">Select subsequence...</option>
                  {subsequences.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.campaign_name} → {s.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={addToSubsequence}
                  disabled={!selectedSub || addingSub}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-indigo-500/20 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 transition-all disabled:opacity-50"
                >
                  {addingSub ? 'Adding...' : 'Add & Done'}
                </button>
                <button
                  onClick={skipSubseq}
                  className="px-3 py-1.5 text-xs font-medium rounded-xl border border-white/10 text-white/40 bg-white/5 hover:bg-white/10 transition-all"
                >
                  Skip
                </button>
              </div>
            )}
          </div>
        )}

        {reply.suggested_macro && reply.suggested_macro !== 'NONE' && !showReply && (
          <p className="text-xs text-white/30">
            Macro: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.suggested_macro}</span>
          </p>
        )}
      </div>

      {showThread && <ThreadModal email={reply.email} api={api} onClose={() => setShowThread(false)} />}
    </>
  );
}

// Deal Pipeline — groups replies by tracking status
function DealPipeline({ replies }) {
  const stages = [
    {
      key: 'follow_up_due',
      label: 'Follow-Up Due',
      emoji: '⚠️',
      color: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
      filter: r => r.follow_up_date && new Date(r.follow_up_date) <= new Date() && !r.handled,
    },
    {
      key: 'needs_action',
      label: 'Needs Action',
      emoji: '🔴',
      color: 'bg-red-500/15 text-red-400 border-red-500/20',
      filter: r => !r.handled && !r.had_meeting && !r.second_call_booked && !r.closed_deal && !r.follow_up_date,
    },
    {
      key: 'follow_up_scheduled',
      label: 'Follow-Up Scheduled',
      emoji: '🔔',
      color: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
      filter: r => r.follow_up_date && new Date(r.follow_up_date) > new Date() && !r.had_meeting && !r.second_call_booked,
    },
    {
      key: 'meeting_set',
      label: 'Meeting Held',
      emoji: '📅',
      color: 'bg-sky-500/15 text-sky-400 border-sky-500/20',
      filter: r => r.had_meeting && !r.second_call_booked && !r.closed_deal,
    },
    {
      key: 'second_call',
      label: '2nd Call Booked',
      emoji: '📞',
      color: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
      filter: r => r.second_call_booked && !r.closed_deal,
    },
    {
      key: 'closed',
      label: 'Closed Deal',
      emoji: '💰',
      color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
      filter: r => r.closed_deal,
    },
    {
      key: 'handled',
      label: 'Done',
      emoji: '✅',
      color: 'bg-green-500/15 text-green-400 border-green-500/20',
      filter: r => r.handled && !r.had_meeting && !r.second_call_booked && !r.closed_deal,
    },
  ];

  const stageCounts = stages.map(s => ({
    ...s,
    count: replies.filter(s.filter).length,
  })).filter(s => s.count > 0);

  if (stageCounts.length === 0) return null;

  const total = stageCounts.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="glass-card rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white/90">Deal Pipeline</h2>
        <span className="text-sm text-white/30">{total} active</span>
      </div>

      {/* Pipeline bar */}
      <div className="flex rounded-xl overflow-hidden h-10 bg-white/5 border border-white/5">
        {stageCounts.map(s => {
          const pct = Math.max((s.count / total) * 100, 8);
          const bgClass = s.color.split(' ')[0];
          return (
            <div
              key={s.key}
              className={`${bgClass} flex items-center justify-center transition-all relative group`}
              style={{ width: `${pct}%` }}
            >
              <span className="text-xs font-bold text-white/80 drop-shadow-sm">{s.count}</span>
              <div className="absolute bottom-full mb-2 px-2 py-1 rounded-lg bg-black/80 text-xs text-white/80 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                {s.emoji} {s.label}: {s.count}
              </div>
            </div>
          );
        })}
      </div>

      {/* Stage pills */}
      <div className="flex flex-wrap gap-2">
        {stageCounts.map(s => (
          <span key={s.key} className={`px-3 py-1.5 rounded-xl text-sm font-medium border ${s.color}`}>
            {s.emoji} {s.label} ({s.count})
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Replies({ api }) {
  const [replies, setReplies] = useState([]);
  const [allReplies, setAllReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [showHandled, setShowHandled] = useState(false);

  const fetchReplies = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter) params.set('classification', filter);
    if (showHandled) params.set('show_handled', 'true');
    params.set('source', 'email');
    params.set('limit', '50');

    fetch(`${api}/api/replies?${params}`)
      .then(r => r.json())
      .then(d => { setReplies(d.replies || []); setLoading(false); })
      .catch(() => setLoading(false));

    // Also fetch all replies (including handled) for pipeline
    const allParams = new URLSearchParams();
    allParams.set('show_handled', 'true');
    allParams.set('source', 'email');
    allParams.set('limit', '200');
    fetch(`${api}/api/replies?${allParams}`)
      .then(r => r.json())
      .then(d => { setAllReplies(d.replies || []); })
      .catch(() => {});
  }, [api, filter, showHandled]);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  const handleDone = (id) => {
    setReplies(prev => prev.filter(r => r.id !== id));
  };

  const handleUpdated = (id, updates) => {
    setReplies(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
    setAllReplies(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const overdueCount = replies.filter(r => r.follow_up_date && new Date(r.follow_up_date) <= new Date() && !r.handled).length;

  return (
    <div className="space-y-6">
      {/* Deal Pipeline */}
      <DealPipeline replies={allReplies} />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-white">Email Replies</h1>
          <span className="text-sm text-white/30">{replies.length} pending</span>
          {overdueCount > 0 && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-400 border border-amber-500/20">
              ⚠️ {overdueCount} follow-up{overdueCount > 1 ? 's' : ''} due
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-white/40 cursor-pointer">
            <input
              type="checkbox"
              checked={showHandled}
              onChange={e => setShowHandled(e.target.checked)}
              className="rounded border-white/20 bg-white/5"
            />
            Show done
          </label>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="glass-input rounded-xl px-3 py-1.5 text-sm"
          >
            <option value="">All Classifications</option>
            {Object.keys(CLASS_COLORS).map(c => (
              <option key={c} value={c}>{CLASS_EMOJI[c] || ''} {c.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <p className="text-white/30 py-10 text-center">Loading...</p>
      ) : replies.length === 0 ? (
        <p className="text-white/30 py-10 text-center">
          {showHandled ? 'No email replies yet' : 'All caught up'}
        </p>
      ) : (
        <div className="space-y-4">
          {replies.map(r => (
            <ReplyCard key={r.id} reply={r} api={api} onHandled={handleDone} onUpdated={handleUpdated} />
          ))}
        </div>
      )}
    </div>
  );
}

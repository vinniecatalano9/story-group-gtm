import { useState, useEffect, useCallback } from 'react';

const CLASS_COLORS = {
  interested: 'bg-green-500/15 text-green-400 border-green-500/20',
  not_interested: 'bg-red-500/15 text-red-400 border-red-500/20',
  why_reach_out: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  more_info: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  cost_question: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  question_other: 'bg-white/10 text-white/50 border-white/10',
  referral: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  re_engage: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  ooo: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
  bounce: 'bg-red-500/15 text-red-400 border-red-500/20',
  other: 'bg-white/10 text-white/50 border-white/10',
};

const CLASS_EMOJI = {
  interested: '🔥',
  not_interested: '🚫',
  why_reach_out: '❓',
  more_info: 'ℹ️',
  cost_question: '💰',
  referral: '🤝',
  re_engage: '🔄',
  ooo: '✈️',
  bounce: '↩️',
  other: '💬',
};

const ULINC_STATUSES = [
  { value: 'talking', label: 'Talking', color: 'bg-green-500 hover:bg-green-600' },
  { value: 'replied', label: 'Replied', color: 'bg-emerald-600 hover:bg-emerald-700' },
  { value: 'meeting_booked', label: 'Meeting Booked', color: 'bg-blue-500 hover:bg-blue-600' },
  { value: 'later', label: 'Later', color: 'bg-gray-500 hover:bg-gray-600' },
  { value: 'no_interest', label: 'No Interest', color: 'bg-orange-500 hover:bg-orange-600' },
  { value: 'old_connect', label: 'Old Connect', color: 'bg-rose-600 hover:bg-rose-700' },
];

function formatTime(created_at) {
  if (!created_at) return '';
  if (created_at?._seconds) return new Date(created_at._seconds * 1000).toLocaleString();
  return new Date(created_at).toLocaleString();
}

function ConversationThread({ contactId, api }) {
  const [messages, setMessages] = useState([]);
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${api}/api/ulinc/conversation/${contactId}`)
      .then(r => r.json())
      .then(d => { setMessages(d.messages || []); setSource(d.source || ''); setLoading(false); })
      .catch(() => setLoading(false));
  }, [contactId, api]);

  if (loading) return <p className="text-xs text-white/30 py-2">Loading conversation...</p>;
  if (!messages.length) return <p className="text-xs text-white/30 py-2">No previous messages</p>;

  const isUlinc = source === 'ulinc';

  return (
    <div className="space-y-2 mt-2 border-t border-white/10 pt-3">
      <p className="text-xs font-medium text-white/40 uppercase tracking-wide">
        Conversation History ({messages.length})
      </p>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {messages.map((m, i) => {
          const isOutgoing = isUlinc ? m.is_incoming === false : false;
          const text = m.message || m.reply_text || '';
          const time = m.created_at;

          return (
            <div
              key={m.id || i}
              className={`text-xs rounded-xl p-2.5 space-y-1 ${
                isOutgoing
                  ? 'bg-brand-500/10 border border-brand-500/15 ml-6'
                  : 'bg-white/5 border border-white/5 mr-6'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-white/40">
                  {isOutgoing ? 'You' : 'Them'}
                  {m.classification && (
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ml-1.5 ${CLASS_COLORS[m.classification] || CLASS_COLORS.other}`}>
                      {m.classification.replace(/_/g, ' ')}
                    </span>
                  )}
                </span>
                <span className="text-white/20">{formatTime(time)}</span>
              </div>
              <p className={isOutgoing ? 'text-brand-300' : 'text-white/50 italic'}>
                {isOutgoing ? '' : '"'}{text.substring(0, 300)}{text.length > 300 ? '...' : ''}{isOutgoing ? '' : '"'}
              </p>
              {m.draft_response && (
                <p className="text-brand-400 bg-brand-500/10 rounded p-1.5 mt-1">
                  Draft: {m.draft_response.substring(0, 150)}{m.draft_response.length > 150 ? '...' : ''}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LinkedInCard({ reply, api, onHandled, onStatusChange }) {
  const [marking, setMarking] = useState(false);
  const [showConvo, setShowConvo] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState(reply.draft_response || '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(reply.ulinc_status || '');
  const [settingStatus, setSettingStatus] = useState(false);
  const cls = reply.classification || 'other';
  const colors = CLASS_COLORS[cls] || CLASS_COLORS.other;
  const emoji = CLASS_EMOJI[cls] || '💬';
  const time = formatTime(reply.message_date || reply.created_at);
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

  const setUlincStatus = async (status) => {
    setSettingStatus(true);
    try {
      await fetch(`${api}/api/replies/${reply.id}/ulinc-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ulinc_status: status }),
      });
      setCurrentStatus(status);
      if (onStatusChange) onStatusChange(reply.id, status);
    } catch { /* ignore */ }
    setSettingStatus(false);
  };

  const sendReply = async () => {
    if (!replyText.trim() || !reply.ulinc_contact_id) return;
    setSending(true);
    try {
      const res = await fetch(`${api}/api/ulinc/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: reply.ulinc_contact_id,
          message: replyText.trim(),
          reply_id: reply.id,
        }),
      });
      if (res.ok) {
        setSent(true);
        setSending(false);
        setShowReply(false);
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

  return (
    <div className={`glass-card glass-card-hover rounded-2xl border ${borderColor} p-5 space-y-3`}>
      <div className="flex items-start justify-between">
        <div>
          <span className="text-lg mr-2">{emoji}</span>
          <span className="font-semibold text-white/90">{reply.contact_name || reply.email}</span>
          {reply.email && reply.contact_name && !reply.email.startsWith('linkedin:') && (
            <span className="ml-1.5 text-xs text-white/30">{reply.email}</span>
          )}
          <span className={`ml-2 inline-block px-2.5 py-0.5 rounded-lg text-xs font-medium ${colors}`}>
            {cls.replace(/_/g, ' ')}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/30">{time}</span>
          {reply.ulinc_contact_id && (
            <button
              onClick={() => setShowConvo(!showConvo)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl border border-sky-500/20 text-sky-400 bg-sky-500/10 hover:bg-sky-500/20 transition-all"
            >
              {showConvo ? 'Hide' : 'Thread'}
            </button>
          )}
          {reply.ulinc_contact_id && !sent && (
            <button
              onClick={() => setShowReply(!showReply)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl border border-indigo-500/20 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 transition-all"
            >
              {showReply ? 'Close' : 'Reply'}
            </button>
          )}
          <button
            onClick={markDone}
            disabled={marking || sent}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl border border-green-500/20 text-green-400 bg-green-500/10 hover:bg-green-500/20 transition-all disabled:opacity-50"
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
          <p className="mt-1 bg-brand-500/10 border border-brand-500/15 rounded-xl p-3 text-white/90">{reply.draft_response}</p>
        </div>
      )}

      {showReply && (
        <div className="space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs font-medium text-white/40 uppercase tracking-wide">Send LinkedIn Reply</p>
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            rows={4}
            className="glass-input w-full text-sm rounded-xl p-3 resize-y"
            placeholder="Type your reply..."
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/30">{replyText.length} chars</span>
            <button
              onClick={sendReply}
              disabled={sending || !replyText.trim()}
              className="glass-btn-primary px-4 py-2 text-sm rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending...' : 'Send via LinkedIn'}
            </button>
          </div>
        </div>
      )}

      {reply.suggested_macro && reply.suggested_macro !== 'NONE' && !showReply && (
        <p className="text-xs text-white/30">
          Macro: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.suggested_macro}</span>
        </p>
      )}

      {/* Ulinc Status Buttons */}
      <div className="flex items-center gap-2 pt-1">
        <span className="text-xs text-white/30 mr-1">Status:</span>
        {ULINC_STATUSES.map(s => (
          <button
            key={s.value}
            onClick={() => setUlincStatus(s.value)}
            disabled={settingStatus}
            className={`px-2.5 py-1 text-xs font-medium rounded-lg text-white transition-all disabled:opacity-50 ${
              currentStatus === s.value
                ? `${s.color} ring-2 ring-white/30`
                : `${s.color} opacity-40 hover:opacity-100`
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {showConvo && reply.ulinc_contact_id && (
        <ConversationThread contactId={reply.ulinc_contact_id} api={api} />
      )}
    </div>
  );
}

export default function LinkedInReplies({ api }) {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showHandled, setShowHandled] = useState(false);

  const fetchReplies = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter) params.set('classification', filter);
    if (statusFilter) params.set('ulinc_status', statusFilter);
    if (showHandled) params.set('show_handled', 'true');
    params.set('source', 'ulinc');
    params.set('limit', '100');

    fetch(`${api}/api/replies?${params}`)
      .then(r => r.json())
      .then(d => {
        const list = (d.replies || []).sort((a, b) => {
          const getMs = (r) => {
            const md = r.message_date;
            const ca = r.created_at;
            if (md?._seconds) return md._seconds * 1000;
            if (md) return new Date(md).getTime();
            if (ca?._seconds) return ca._seconds * 1000;
            if (ca) return new Date(ca).getTime();
            return 0;
          };
          return getMs(b) - getMs(a);
        });
        setReplies(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [api, filter, statusFilter, showHandled]);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  const handleDone = (id) => {
    setReplies(prev => prev.filter(r => r.id !== id));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-white">LinkedIn Messages</h1>
          <span className="text-sm text-white/30">{replies.length} pending</span>
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
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="glass-input rounded-xl px-3 py-1.5 text-sm"
          >
            <option value="">All Statuses</option>
            {ULINC_STATUSES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
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
          {showHandled ? 'No LinkedIn messages yet' : 'All caught up'}
        </p>
      ) : (
        <div className="space-y-4">
          {replies.map(r => <LinkedInCard key={r.id} reply={r} api={api} onHandled={handleDone} onStatusChange={(id, status) => {
            setReplies(prev => prev.map(p => p.id === id ? { ...p, ulinc_status: status } : p));
          }} />)}
        </div>
      )}
    </div>
  );
}

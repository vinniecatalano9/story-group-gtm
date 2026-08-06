import { useState, useEffect, useCallback } from 'react';

const CLASS_COLORS = {
  interested: 'bg-green-500/15 text-green-400 border-green-500/20',
  not_interested: 'bg-red-500/15 text-red-400 border-red-500/20',
  why_reach_out: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  more_info: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  send_info: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  cost_question: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  cost_question_repeat: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  guarantee: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
  timing_objection: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  times_rejected: 'bg-sky-500/15 text-sky-400 border-sky-500/20',
  ghost_followup: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
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
  send_info: '📄',
  cost_question: '💰',
  cost_question_repeat: '💰',
  guarantee: '🛡️',
  timing_objection: '🗓️',
  times_rejected: '🔁',
  ghost_followup: '👻',
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

/**
 * The whole back-and-forth for a HeyReach conversation, laid out like a chat:
 * theirs on the left, ours on the right, oldest first. Messages are never
 * truncated — the point of opening a thread is to read what was actually said.
 */
function HeyreachThread({ conversationId, api }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetch(`${api}/api/heyreach/thread/${encodeURIComponent(conversationId)}`)
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.error || 'Failed')))
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [conversationId, api]);

  if (error) return <p className="text-xs text-red-400/80 py-2">Couldn't load the thread: {error}</p>;
  if (!data) return <p className="text-xs text-white/30 py-2">Loading conversation...</p>;
  if (!data.messages.length) return <p className="text-xs text-white/30 py-2">No messages in this thread</p>;

  const stamp = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="mt-2 border-t border-white/10 pt-3">
      <p className="text-xs font-medium text-white/40 uppercase tracking-wide mb-2">
        Conversation · {data.totalMessages} message{data.totalMessages === 1 ? '' : 's'}
      </p>
      <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
        {data.messages.map((m, i) => (
          <div key={i} className={`flex ${m.outgoing ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[82%] rounded-2xl px-3 py-2 text-sm ${
                m.outgoing
                  ? 'bg-indigo-500/15 border border-indigo-400/20 rounded-br-sm'
                  : 'bg-white/5 border border-white/10 rounded-bl-sm'
              }`}
            >
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${m.outgoing ? 'text-indigo-300/80' : 'text-white/40'}`}>
                  {m.outgoing ? 'Us' : (data.correspondent.name || 'Them')}
                </span>
                {m.isInMail && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300/90">InMail</span>}
                <span className="text-[10px] text-white/25 ml-auto">{stamp(m.createdAt)}</span>
              </div>
              {m.subject && <p className="text-[11px] font-semibold text-white/50 mb-1">{m.subject}</p>}
              <p className={`whitespace-pre-line leading-relaxed ${m.outgoing ? 'text-white/80' : 'text-white/70'}`}>
                {m.body}
              </p>
            </div>
          </div>
        ))}
      </div>
      {data.lastMessageSender === 'CORRESPONDENT' && (
        <p className="text-[11px] text-amber-400/80 mt-2">They spoke last. The ball is with us.</p>
      )}
    </div>
  );
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

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <button
      onClick={copy}
      className={`shrink-0 px-2 py-1 text-[10px] font-medium rounded-lg border transition-all ${
        copied
          ? 'border-green-500/30 text-green-400 bg-green-500/10'
          : 'border-white/10 text-white/40 bg-white/5 hover:text-white/80 hover:bg-white/10'
      }`}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

// Strip the "Message N:" label — copy/send the text the prospect should actually see
function stripLabel(block) {
  return block.replace(/^Message\s*\d+\s*:\s*/i, '').trim();
}

function LinkedInCard({ reply, api, onHandled, onStatusChange }) {
  const [marking, setMarking] = useState(false);
  const [showConvo, setShowConvo] = useState(false);
  const [showFullMsg, setShowFullMsg] = useState(false);
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

  const isHeyreach = reply.source === 'heyreach';
  const canSend = isHeyreach || reply.ulinc_contact_id;

  // HeyReach drafts are 2-3 separate LinkedIn messages — each gets its own
  // box + Send button so Vincent controls the pacing (never all at once).
  const [msgBlocks, setMsgBlocks] = useState(() => {
    const blocks = (reply.draft_response || '')
      .split(/\n{2,}/)
      .map(b => stripLabel(b))
      .filter(Boolean)
      .map(text => ({ text, sent: false, sending: false }));
    return blocks.length ? blocks : [{ text: '', sent: false, sending: false }];
  });

  const sendBlock = async (i) => {
    const block = msgBlocks[i];
    if (!block.text.trim() || block.sent || block.sending) return;
    const isLast = msgBlocks.every((b, j) => j === i || b.sent);
    setMsgBlocks(prev => prev.map((b, j) => j === i ? { ...b, sending: true } : b));
    try {
      const res = await fetch(`${api}/api/heyreach/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply_id: reply.id, message: block.text.trim(), single: true, done: isLast }),
      });
      if (res.ok) {
        setMsgBlocks(prev => prev.map((b, j) => j === i ? { ...b, sent: true, sending: false } : b));
        if (isLast) { setSent(true); setShowReply(false); }
      } else {
        const err = await res.json();
        alert(`Send failed: ${err.error || 'Unknown error'}`);
        setMsgBlocks(prev => prev.map((b, j) => j === i ? { ...b, sending: false } : b));
      }
    } catch {
      alert('Send failed — check connection');
      setMsgBlocks(prev => prev.map((b, j) => j === i ? { ...b, sending: false } : b));
    }
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
          <span className="font-semibold text-white/90">
            {reply.contact_name || reply.full_name || reply.lead_name || reply.email || 'Unknown'}
          </span>
          {reply.company_name && (
            <span className="ml-1.5 text-xs text-white/30">· {reply.company_name}</span>
          )}
          {reply.email && reply.contact_name && !reply.email.startsWith('linkedin:') && (
            <span className="ml-1.5 text-xs text-white/30">{reply.email}</span>
          )}
          <span className={`ml-2 inline-block px-2.5 py-0.5 rounded-lg text-xs font-medium ${colors}`}>
            {cls.replace(/_/g, ' ')}
          </span>
          {reply.auto_tag_interested && (
            <span className="ml-1.5 inline-block px-2.5 py-0.5 rounded-lg text-xs font-medium bg-green-500/15 text-green-400 border border-green-500/20">
              ⚡ HeyReach: Interested
            </span>
          )}
          <div className="mt-1 flex items-center gap-3">
            {reply.profile_url && (
              <a
                href={reply.profile_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-sky-400 hover:text-sky-300 hover:underline"
              >
                LinkedIn Profile ↗
              </a>
            )}
            {reply.source === 'heyreach' && (
              <a
                href="https://app.heyreach.io/inbox"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-indigo-400 hover:text-indigo-300 hover:underline"
              >
                HeyReach Inbox ↗
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {reply.heyreach_account_name && (
            <span className="text-xs text-white/25">via {reply.heyreach_account_name}</span>
          )}
          <span className="text-xs text-white/30">{time}</span>
          {/* How long they've been waiting on us. Silent under 2 days, then
              increasingly loud — the point is that a good reply going stale is
              the expensive failure, not an untidy queue. */}
          {(() => {
            const raw = reply.message_date || reply.created_at;
            const ms = raw?._seconds ? raw._seconds * 1000 : (raw ? new Date(raw).getTime() : 0);
            if (!ms) return null;
            const d = Math.floor((Date.now() - ms) / 86400000);
            if (d < 2) return null;
            const tone = d >= 7 ? 'border-red-500/30 text-red-300 bg-red-500/15'
              : d >= 3 ? 'border-amber-500/30 text-amber-300 bg-amber-500/15'
              : 'border-white/10 text-white/40 bg-white/5';
            return (
              <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-lg border ${tone}`}>
                waiting {d}d
              </span>
            );
          })()}
          {/* Thread used to be Ulinc-only, so the whole HeyReach queue had no way
              to see what had already been said. */}
          {(reply.ulinc_contact_id || reply.heyreach_conversation_id) && (
            <button
              onClick={() => setShowConvo(!showConvo)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-xl border border-sky-500/20 text-sky-400 bg-sky-500/10 hover:bg-sky-500/20 transition-all"
            >
              {showConvo ? 'Hide' : 'Thread'}
            </button>
          )}
          {canSend && !sent && (
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

      {/* Their message. This used to hard-truncate at 300 characters, which quietly
          hid the end of every long reply — and a long reply is usually the most
          revealing one. Nothing is cut now; long messages collapse to a readable
          height with the full text one click away, and line breaks are kept. */}
      {(() => {
        const full = reply.reply_text || '';
        const long = full.length > 400;
        return (
          <div className="text-sm text-white/60 bg-white/5 rounded-xl p-3 border border-white/5">
            <p
              className={`italic whitespace-pre-line leading-relaxed ${long && !showFullMsg ? 'max-h-28 overflow-hidden' : ''}`}
              style={long && !showFullMsg ? { maskImage: 'linear-gradient(to bottom, black 60%, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent)' } : undefined}
            >
              "{full}"
            </p>
            {long && (
              <button
                onClick={() => setShowFullMsg(v => !v)}
                className="mt-1.5 text-xs font-medium text-indigo-400 hover:text-indigo-300"
              >
                {showFullMsg ? 'Show less' : `Show full message (${full.length.toLocaleString()} chars)`}
              </button>
            )}
          </div>
        );
      })()}

      {reply.summary && reply.summary !== 'Classification failed' && (
        <p className="text-sm text-white/50">
          <span className="font-medium text-white/60">Summary:</span> {reply.summary}
        </p>
      )}

      {reply.draft_response && !showReply && (
        <div className="text-sm">
          <span className="font-medium text-white/50">Suggested Reply:</span>
          <div className="mt-1 space-y-2">
            {reply.draft_response.split(/\n{2,}/).map((block, i) => (
              <div
                key={i}
                className="flex items-start gap-2 bg-brand-500/10 border border-brand-500/15 rounded-xl p-3"
              >
                <p className="flex-1 text-white/90 whitespace-pre-line leading-relaxed">{block.trim()}</p>
                <CopyButton text={stripLabel(block)} />
              </div>
            ))}
          </div>
        </div>
      )}

      {showReply && isHeyreach && (
        <div className="space-y-3 border-t border-white/10 pt-3">
          <p className="text-xs font-medium text-white/40 uppercase tracking-wide">
            Send LinkedIn Reply — one message at a time, you control the pacing
          </p>
          {msgBlocks.map((b, i) => (
            <div key={i} className={`space-y-1.5 ${b.sent ? 'opacity-50' : ''}`}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-white/30 uppercase tracking-wide">Message {i + 1}</span>
                {b.sent && <span className="text-[10px] text-green-400">✓ Sent</span>}
              </div>
              <div className="flex items-start gap-2">
                <textarea
                  value={b.text}
                  disabled={b.sent}
                  onChange={e => setMsgBlocks(prev => prev.map((p, j) => j === i ? { ...p, text: e.target.value } : p))}
                  rows={Math.max(2, Math.ceil(b.text.length / 80))}
                  className="glass-input flex-1 text-sm rounded-xl p-3 resize-y disabled:opacity-60"
                  placeholder="Type your message..."
                />
                <button
                  onClick={() => sendBlock(i)}
                  disabled={b.sent || b.sending || !b.text.trim() || (i > 0 && !msgBlocks[i - 1].sent)}
                  className="glass-btn-primary shrink-0 px-3 py-2 text-xs rounded-xl disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {b.sent ? 'Sent' : b.sending ? '...' : 'Send'}
                </button>
              </div>
            </div>
          ))}
          <p className="text-[10px] text-white/25">
            Messages send in order — Message 2 unlocks after Message 1 is sent. The card marks done after the last one.
          </p>
        </div>
      )}

      {showReply && !isHeyreach && (
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

      {/* Macro + the two things the Jul 22 audit found missing on every reply:
          the Instantly tag and the sub-sequence. Both are manual in Instantly —
          this is the reminder, not the action. */}
      {!showReply && (reply.suggested_macro && reply.suggested_macro !== 'NONE' || reply.tag || reply.subsequence) && (
        <p className="text-xs text-white/30 flex items-center gap-2 flex-wrap">
          {reply.suggested_macro && reply.suggested_macro !== 'NONE' && (
            <span>Macro: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.suggested_macro}</span></span>
          )}
          {reply.tag && (
            <span>Tag: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.tag}</span></span>
          )}
          {reply.subsequence && (
            <span>Sub-seq: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.subsequence}</span></span>
          )}
          {reply.followups_recommended > 0 && (
            <span className="text-white/25">follow up ~{reply.followups_recommended}x</span>
          )}
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

      {showConvo && (
        reply.heyreach_conversation_id
          ? <HeyreachThread conversationId={reply.heyreach_conversation_id} api={api} />
          : reply.ulinc_contact_id
            ? <ConversationThread contactId={reply.ulinc_contact_id} api={api} />
            : null
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
  // Default ON — open straight to the leads worth time. Toggle off to see everything.
  const [interestedOnly, setInterestedOnly] = useState(true);
  // "Needs reply" header button — the short list the team actually owes an answer to.
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  // Sender accounts toggled OFF. Persisted per browser via the sender chips.
  // Aaron used to be force-hidden on every load; that's off now — his threads
  // show like everyone else's, and hiding any sender is a manual choice that
  // sticks until it's toggled back.
  const [hiddenSenders, setHiddenSenders] = useState(() => {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('li_hidden_senders') || '[]'); } catch { /* ignore */ }
    return new Set(stored);
  });

  const senderOf = (r) => r.heyreach_account_name || r.ulinc_account_name || 'Other';

  const toggleSender = (name) => {
    setHiddenSenders(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      try { localStorage.setItem('li_hidden_senders', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  // Worth working. This used to be a whitelist of four classifications, which
  // meant a timing objection, a process question, a referral or a "send me info"
  // all fell out of the default view — everything that isn't a flat no is worth
  // a reply, so this is a blocklist now: hide the hard nos and the noise, show
  // the rest.
  const NOT_WORTH_WORKING = ['not_interested', 'ooo', 'bounce'];
  const isHot = (r) =>
    r.auto_tag_interested === true ||
    !NOT_WORTH_WORKING.includes(r.classification);

  // "Needs reply" is tighter than "not a no": a real buying signal a person is
  // waiting on. 'other' and 'question_other' are deliberately out — they're the
  // catch-all buckets and they're where the noise lands.
  const NEEDS_REPLY = [
    'interested', 'cost_question', 'cost_question_repeat', 'more_info', 'send_info',
    'guarantee', 'timing_objection', 'times_rejected', 'why_reach_out', 'referral', 're_engage',
  ];
  const needsReply = (r) =>
    r.auto_tag_interested === true || NEEDS_REPLY.includes(r.classification);

  // How long they've been waiting on us.
  const waitedDays = (r) => {
    const raw = r.message_date || r.created_at;
    const ms = raw?._seconds ? raw._seconds * 1000 : (raw ? new Date(raw).getTime() : 0);
    if (!ms) return null;
    return Math.floor((Date.now() - ms) / 86400000);
  };

  const fetchReplies = useCallback(() => {
    setLoading(true);
    // LinkedIn replies arrive under 'heyreach' (current, since 2026-05-11) AND 'ulinc' (legacy pre-May 11).
    // Fetch both sources in parallel and merge so all LinkedIn conversations show up here.
    const baseParams = new URLSearchParams();
    if (filter) baseParams.set('classification', filter);
    if (statusFilter) baseParams.set('ulinc_status', statusFilter);
    if (showHandled) baseParams.set('show_handled', 'true');
    baseParams.set('limit', '150');

    const fetchSource = (source) => {
      const p = new URLSearchParams(baseParams);
      p.set('source', source);
      return fetch(`${api}/api/replies?${p}`).then(r => r.json()).catch(() => ({ replies: [] }));
    };

    Promise.all([fetchSource('heyreach'), fetchSource('ulinc')])
      .then(([hr, ul]) => {
        const all = [...(hr.replies || []), ...(ul.replies || [])];
        const seen = new Set();
        const deduped = [];
        for (const r of all) {
          if (r && r.id && !seen.has(r.id)) { seen.add(r.id); deduped.push(r); }
        }
        const list = deduped.sort((a, b) => {
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
          <span className="text-sm text-white/30">
            {replies.filter(r => (!interestedOnly || isHot(r)) && !hiddenSenders.has(senderOf(r))).length} pending
          </span>
          {(() => {
            const owed = replies.filter(r => needsReply(r) && !hiddenSenders.has(senderOf(r)));
            const stale = owed.filter(r => (waitedDays(r) ?? 0) >= 3).length;
            return (
              <button
                onClick={() => setNeedsReplyOnly(!needsReplyOnly)}
                title={stale ? `${stale} have been waiting 3+ days` : 'Real buying signals waiting on a reply'}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm font-semibold rounded-xl border transition-all ${
                  needsReplyOnly
                    ? 'border-amber-400/50 text-amber-300 bg-amber-500/20 ring-1 ring-amber-400/30'
                    : owed.length
                      ? 'border-amber-500/30 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
                      : 'border-white/10 text-white/30 bg-white/5'
                }`}
              >
                <span className={owed.length ? 'animate-pulse' : ''}>●</span>
                NEED TO RESPOND
                <span className="px-1.5 py-0.5 rounded-md bg-amber-400/20 text-amber-200 text-xs tabular-nums">
                  {owed.length}
                </span>
                {stale > 0 && (
                  <span className="text-xs font-normal text-red-300/90">{stale} over 3d</span>
                )}
              </button>
            );
          })()}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setInterestedOnly(!interestedOnly)}
            className={`px-3 py-1.5 text-sm font-medium rounded-xl border transition-all ${
              interestedOnly
                ? 'border-green-500/30 text-green-400 bg-green-500/15 ring-1 ring-green-500/20'
                : 'border-white/10 text-white/40 bg-white/5 hover:text-white/70'
            }`}
          >
            🔥 Hide the nos
          </button>
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

      {/* Sender chips — click a name to hide/show that account's threads */}
      {!loading && replies.length > 0 && (() => {
        const senders = [...new Set(replies.map(senderOf))].sort();
        if (senders.length < 2) return null;
        return (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-white/30">Senders:</span>
            {senders.map(name => {
              const hidden = hiddenSenders.has(name);
              const count = replies.filter(r => senderOf(r) === name && (!interestedOnly || isHot(r))).length;
              return (
                <button
                  key={name}
                  onClick={() => toggleSender(name)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-all ${
                    hidden
                      ? 'border-white/10 text-white/25 bg-white/5 line-through'
                      : 'border-sky-500/20 text-sky-400 bg-sky-500/10 hover:bg-sky-500/20'
                  }`}
                >
                  {name} ({count})
                </button>
              );
            })}
          </div>
        );
      })()}

      {loading ? (
        <p className="text-white/30 py-10 text-center">Loading...</p>
      ) : (() => {
        const visible = replies
          .filter(r => (!interestedOnly || isHot(r)) && !hiddenSenders.has(senderOf(r)))
          .filter(r => !needsReplyOnly || needsReply(r));
        if (visible.length === 0) {
          return (
            <p className="text-white/30 py-10 text-center">
              {needsReplyOnly
                ? 'Nobody is waiting on a reply. Nice.'
                : interestedOnly && replies.length > 0
                ? `Nothing left to work — ${replies.length} message${replies.length === 1 ? '' : 's'} hidden as nos, out-of-office or bounces`
                : showHandled ? 'No LinkedIn messages yet' : 'All caught up'}
            </p>
          );
        }
        return (
          <div className="space-y-4">
            {visible.map(r => <LinkedInCard key={r.id} reply={r} api={api} onHandled={handleDone} onStatusChange={(id, status) => {
              setReplies(prev => prev.map(p => p.id === id ? { ...p, ulinc_status: status } : p));
            }} />)}
          </div>
        );
      })()}
    </div>
  );
}

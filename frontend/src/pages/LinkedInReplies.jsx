import { useState, useEffect, useCallback, useRef } from 'react';

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
  question_other: 'bg-white/10 text-white/75 border-white/10',
  referral: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  re_engage: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  ooo: 'bg-gray-500/15 text-gray-400 border-gray-500/20',
  bounce: 'bg-red-500/15 text-red-400 border-red-500/20',
  other: 'bg-white/10 text-white/75 border-white/10',
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

// Thread requests are capped globally. Before its data arrives each thread is a
// one-line placeholder, so a full queue collapses to well under a screen and
// every card reports itself visible at once — 78 simultaneous requests, which
// the API serialises until nothing finishes. The observer decides WHICH threads
// load; this decides HOW MANY at a time.
const THREAD_CONCURRENCY = 3;
let threadsInFlight = 0;
const threadQueue = [];
function runQueuedThreads() {
  while (threadsInFlight < THREAD_CONCURRENCY && threadQueue.length) {
    const job = threadQueue.shift();
    threadsInFlight++;
    job().finally(() => { threadsInFlight--; runQueuedThreads(); });
  }
}
function queueThreadFetch(job) {
  threadQueue.push(job);
  runQueuedThreads();
}

/**
 * The whole back-and-forth for a HeyReach conversation, laid out like a chat:
 * theirs on the left, ours on the right, oldest first. Messages are never
 * truncated — the point of opening a thread is to read what was actually said.
 */
function HeyreachThread({ conversationId, api, leadName, accountId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  // No visibility gate: before its data arrives a thread is a short placeholder,
  // so a full queue collapses to under a screen and every card reports itself
  // visible at once anyway. The concurrency cap above is what actually protects
  // the API, and it drains in DOM order so the cards on screen resolve first.
  useEffect(() => {
    let live = true;
    // Name + account let the API find the thread in one call instead of crawling
    // the whole inbox. See the route for why.
    const qs = new URLSearchParams();
    if (leadName) qs.set('name', leadName);
    if (accountId) qs.set('accountId', accountId);
    queueThreadFetch(() =>
      fetch(`${api}/api/heyreach/thread/${encodeURIComponent(conversationId)}${qs.toString() ? '?' + qs : ''}`)
        .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e.error || 'Failed')))
        .then(d => { if (live) setData(d); })
        .catch(e => { if (live) setError(String(e)); })
    );
    return () => { live = false; };
  }, [conversationId, api, leadName, accountId]);

  // Open on the newest message, the way a chat app does — the latest exchange is
  // what you're replying to. Scrolling up for the history is the deliberate act.
  useEffect(() => {
    if (!data || !scrollRef.current) return;
    const el = scrollRef.current;
    el.scrollTop = el.scrollHeight;
  }, [data]);

  if (error) return <p className="text-xs text-red-400/80 py-2">Couldn't load the thread: {error}</p>;
  if (!data) return (
    <div className="mt-2 border-t border-white/10 pt-3 min-h-[5rem]">
      <p className="text-xs text-white/55">Loading conversation...</p>
    </div>
  );
  if (!data.messages.length) return <p className="text-xs text-white/55 py-2">No messages in this thread</p>;

  const stamp = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="mt-2 border-t border-white/10 pt-3">
      <p className="text-xs font-medium text-white/65 uppercase tracking-wide mb-2">
        Conversation · {data.totalMessages} message{data.totalMessages === 1 ? '' : 's'}
      </p>
      <div ref={scrollRef} className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
        {data.messages.map((m, i) => (
          <div key={i} className={`flex ${m.outgoing ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed ${
                m.outgoing
                  ? 'bg-indigo-500/15 border border-indigo-400/20 rounded-br-sm'
                  : 'bg-white/5 border border-white/10 rounded-bl-sm'
              }`}
            >
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className={`text-[11px] font-semibold uppercase tracking-wide ${m.outgoing ? 'text-indigo-300/80' : 'text-white/65'}`}>
                  {m.outgoing ? 'Us' : (data.correspondent.name || 'Them')}
                </span>
                {m.isInMail && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300/90">InMail</span>}
                <span className="text-[11px] text-white/55 ml-auto">{stamp(m.createdAt)}</span>
              </div>
              {m.subject && <p className="text-[11px] font-semibold text-white/75 mb-1">{m.subject}</p>}
              <p className={`whitespace-pre-line leading-relaxed ${m.outgoing ? 'text-white/90' : 'text-white/85'}`}>
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

  if (loading) return <p className="text-xs text-white/55 py-2">Loading conversation...</p>;
  if (!messages.length) return <p className="text-xs text-white/55 py-2">No previous messages</p>;

  const isUlinc = source === 'ulinc';

  return (
    <div className="space-y-2 mt-2 border-t border-white/10 pt-3">
      <p className="text-xs font-medium text-white/65 uppercase tracking-wide">
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
                <span className="font-medium text-white/65">
                  {isOutgoing ? 'You' : 'Them'}
                  {m.classification && (
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ml-1.5 ${CLASS_COLORS[m.classification] || CLASS_COLORS.other}`}>
                      {m.classification.replace(/_/g, ' ')}
                    </span>
                  )}
                </span>
                <span className="text-white/55">{formatTime(time)}</span>
              </div>
              <p className={isOutgoing ? 'text-brand-300' : 'text-white/75 italic'}>
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
      className={`shrink-0 px-2 py-1 text-[11px] font-medium rounded-lg border transition-all ${
        copied
          ? 'border-green-500/30 text-green-400 bg-green-500/10'
          : 'border-white/10 text-white/65 bg-white/5 hover:text-white/90 hover:bg-white/10'
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
  // Collapsed by default. Opening every card eagerly meant ~90 thread fetches on
  // load and a page full of "Loading conversation...". The affordance below the
  // message is what makes it findable, which was the actual problem.
  const [showConvo, setShowConvo] = useState(false);
  const [showFullMsg, setShowFullMsg] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [redrafting, setRedrafting] = useState(false);
  const [redraftErr, setRedraftErr] = useState('');
  // The draft and macro live in state so a rewrite lands in place on this card
  // instead of needing a page refresh to be seen.
  const [draft, setDraft] = useState(reply.draft_response || '');
  const [macro, setMacro] = useState(reply.suggested_macro || '');
  const [lastNote, setLastNote] = useState(reply.last_feedback || '');
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

  const redraft = async () => {
    if (!feedback.trim() || redrafting) return;
    setRedrafting(true); setRedraftErr('');
    try {
      const res = await fetch(`${api}/api/heyreach/redraft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply_id: reply.id, feedback: feedback.trim() }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Rewrite failed');
      const next = d.draft_response || '';
      setDraft(next);
      setMacro(d.suggested_macro || '');
      setLastNote(feedback.trim());
      // Re-seed the per-message send boxes so the rewrite is what actually goes out.
      setMsgBlocks(next.split(/\n{2,}/).map(t => stripLabel(t)).filter(Boolean)
        .map(text => ({ text, sent: false, sending: false })));
      setReplyText(next);
      setFeedback('');
    } catch (e) {
      setRedraftErr(String(e.message || e));
    }
    setRedrafting(false);
  };

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
            <span className="ml-1.5 text-xs text-white/55">· {reply.company_name}</span>
          )}
          {reply.email && reply.contact_name && !reply.email.startsWith('linkedin:') && (
            <span className="ml-1.5 text-xs text-white/55">{reply.email}</span>
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
            <span className="text-xs text-white/55">via {reply.heyreach_account_name}</span>
          )}
          <span className="text-xs text-white/55">{time}</span>
          {/* Not-worth-working flag from the headline. A prompt for a human, not
              an auto-hide: it says why, and the card stays workable. */}
          {reply.icp?.verdict === 'kill' && (
            <span
              title={reply.headline ? `Headline: ${reply.headline.slice(0, 220)}` : ''}
              className="px-2 py-0.5 text-[11px] font-semibold rounded-lg border border-rose-500/30 text-rose-300 bg-rose-500/15"
            >
              NOT ICP · {reply.icp.reason}
            </span>
          )}
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
              : 'border-white/10 text-white/65 bg-white/5';
            return (
              <span className={`px-2 py-0.5 text-[11px] font-semibold rounded-lg border ${tone}`}>
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
          <div className="text-white/85 bg-white/[0.07] rounded-xl p-3.5 border border-white/10">
            <p
              className={`whitespace-pre-line leading-relaxed text-[15px] ${long && !showFullMsg ? 'max-h-32 overflow-hidden' : ''}`}
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

      {(reply.heyreach_conversation_id || reply.ulinc_contact_id) && (
        <button
          onClick={() => setShowConvo(!showConvo)}
          className="flex items-center gap-2 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <span className="text-base leading-none">💬</span>
          {showConvo ? 'Hide full conversation' : 'Open full conversation'}
          <span className="text-white/40">{showConvo ? '▴' : '▾'}</span>
        </button>
      )}

      {showConvo && (
        reply.heyreach_conversation_id
          ? <HeyreachThread
              conversationId={reply.heyreach_conversation_id}
              api={api}
              leadName={reply.full_name || ''}
              accountId={reply.heyreach_account_id || null}
            />
          : reply.ulinc_contact_id
            ? <ConversationThread contactId={reply.ulinc_contact_id} api={api} />
            : null
      )}

      {reply.summary && reply.summary !== 'Classification failed' && (
        <p className="text-sm text-white/75">
          <span className="font-medium text-white/85">Summary:</span> {reply.summary}
        </p>
      )}

      {draft && !showReply && (
        <div className="text-sm">
          <span className="font-medium text-white/75">Suggested Reply:</span>
          <div className="mt-1 space-y-2">
            {draft.split(/\n{2,}/).map((block, i) => (
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
          <p className="text-xs font-medium text-white/65 uppercase tracking-wide">
            Send LinkedIn Reply — one message at a time, you control the pacing
          </p>
          {msgBlocks.map((b, i) => (
            <div key={i} className={`space-y-1.5 ${b.sent ? 'opacity-50' : ''}`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-white/55 uppercase tracking-wide">Message {i + 1}</span>
                {b.sent && <span className="text-[11px] text-green-400">✓ Sent</span>}
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
          <p className="text-[11px] text-white/55">
            Messages send in order — Message 2 unlocks after Message 1 is sent. The card marks done after the last one.
          </p>
        </div>
      )}

      {showReply && !isHeyreach && (
        <div className="space-y-2 border-t border-white/10 pt-3">
          <p className="text-xs font-medium text-white/65 uppercase tracking-wide">Send LinkedIn Reply</p>
          <textarea
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            rows={4}
            className="glass-input w-full text-sm rounded-xl p-3 resize-y"
            placeholder="Type your reply..."
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-white/55">{replyText.length} chars</span>
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
      {/* Say what's wrong in a sentence and the draft is rewritten around it.
          The alternative was editing by hand and losing whatever the macro got
          right. House rules still apply to the rewrite. */}
      {!showReply && (
        <div className="space-y-1.5">
          {!draft && (
            <p className="text-sm text-white/55">
              <span className="inline-block animate-pulse">✎</span> Writing a suggested reply. It lands in about a minute, or ask for something specific below.
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              value={feedback}
              onChange={e => { setFeedback(e.target.value); setRedraftErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter' && feedback.trim() && !redrafting) redraft(); }}
              disabled={redrafting}
              placeholder={draft
                ? 'Not quite? Say what to change, e.g. mention we also do PR for companies raising a round'
                : 'Ask for a reply, e.g. give me two options, one that waits for the hire and one that does not'}
              className="flex-1 text-sm rounded-xl px-3 py-2 bg-white/5 border border-white/10 text-white/85 placeholder:text-white/40 focus:outline-none focus:border-indigo-400/60 disabled:opacity-50"
            />
            <button
              onClick={redraft}
              disabled={redrafting || !feedback.trim()}
              className="px-3 py-2 text-sm font-medium rounded-xl border border-indigo-500/30 text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {redrafting ? (draft ? 'Rewriting...' : 'Drafting...') : (draft ? 'Rewrite' : 'Draft it')}
            </button>
          </div>
          {redraftErr && <p className="text-xs text-red-400">{redraftErr}</p>}
          {lastNote && !feedback && !redrafting && (
            <p className="text-xs text-white/40">Last note: {lastNote}</p>
          )}
        </div>
      )}

      {!showReply && (macro && macro !== 'NONE' || reply.tag || reply.subsequence) && (
        <p className="text-xs text-white/55 flex items-center gap-2 flex-wrap">
          {macro && macro !== 'NONE' && (
            <span>Macro: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{macro}</span></span>
          )}
          {reply.tag && (
            <span>Tag: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.tag}</span></span>
          )}
          {reply.subsequence && (
            <span>Sub-seq: <span className="font-mono bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{reply.subsequence}</span></span>
          )}
          {reply.followups_recommended > 0 && (
            <span className="text-white/55">follow up ~{reply.followups_recommended}x</span>
          )}
        </p>
      )}

      {/* Ulinc Status Buttons */}
      <div className="flex items-center gap-2 pt-1">
        <span className="text-xs text-white/55 mr-1">Status:</span>
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

    </div>
  );
}

export default function LinkedInReplies({ api }) {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Name search. Client-side over what's already loaded — the queue is capped at
  // 150 per source, so there's nothing to fetch and it stays instant.
  const [search, setSearch] = useState('');
  const [showHandled, setShowHandled] = useState(false);
  // Default ON — open straight to the leads worth time. Toggle off to see everything.
  const [interestedOnly, setInterestedOnly] = useState(true);
  // "Needs reply" header button — the short list the team actually owes an answer to.
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const [hideNonIcp, setHideNonIcp] = useState(false);
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

  // Name search matches the person, their company and their email.
  const matchesSearch = (r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.contact_name, r.full_name, r.lead_name, r.company_name, r.email]
      .some(v => v && String(v).toLowerCase().includes(q));
  };

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
          <span className="text-sm text-white/55">
            {search.trim()
              ? `${replies.filter(matchesSearch).length} match${replies.filter(matchesSearch).length === 1 ? '' : 'es'}`
              : `${replies.filter(r => (!interestedOnly || isHot(r)) && !hiddenSenders.has(senderOf(r))).length} pending`}
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
                      : 'border-white/10 text-white/55 bg-white/5'
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
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40 pointer-events-none">⌕</span>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSearch(''); }}
              placeholder="Search name or company"
              className="glass-input rounded-xl pl-8 pr-7 py-1.5 text-sm w-56"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                title="Clear"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 text-sm"
              >
                ×
              </button>
            )}
          </div>
          <button
            onClick={() => setInterestedOnly(!interestedOnly)}
            className={`px-3 py-1.5 text-sm font-medium rounded-xl border transition-all ${
              interestedOnly
                ? 'border-green-500/30 text-green-400 bg-green-500/15 ring-1 ring-green-500/20'
                : 'border-white/10 text-white/65 bg-white/5 hover:text-white/85'
            }`}
          >
            🔥 Hide the nos
          </button>
          {(() => {
            const n = replies.filter(r => r.icp?.verdict === 'kill' && !hiddenSenders.has(senderOf(r))).length;
            if (!n) return null;
            return (
              <button
                onClick={() => setHideNonIcp(!hideNonIcp)}
                title="Students, retired, job seekers, support roles, sub-founder titles and PR competitors"
                className={`px-3 py-1.5 text-sm font-medium rounded-xl border transition-all ${
                  hideNonIcp
                    ? 'border-rose-500/40 text-rose-300 bg-rose-500/20 ring-1 ring-rose-500/20'
                    : 'border-white/10 text-white/65 bg-white/5 hover:text-white/85'
                }`}
              >
                Hide non-ICP ({n})
              </button>
            );
          })()}
          <label className="flex items-center gap-2 text-sm text-white/65 cursor-pointer">
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
            <span className="text-xs text-white/55">Senders:</span>
            {senders.map(name => {
              const hidden = hiddenSenders.has(name);
              const count = replies.filter(r => senderOf(r) === name && (!interestedOnly || isHot(r))).length;
              return (
                <button
                  key={name}
                  onClick={() => toggleSender(name)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-all ${
                    hidden
                      ? 'border-white/10 text-white/55 bg-white/5 line-through'
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
        <p className="text-white/55 py-10 text-center">Loading...</p>
      ) : (() => {
        // A name search looks past every hide toggle — if you're looking for a
        // specific person, "no results" because they were filed as a no is a
        // worse answer than showing them.
        const searching = search.trim().length > 0;
        const visible = searching
          ? replies.filter(matchesSearch)
          : replies
            .filter(r => (!interestedOnly || isHot(r)) && !hiddenSenders.has(senderOf(r)))
            .filter(r => !needsReplyOnly || needsReply(r))
            .filter(r => !hideNonIcp || r.icp?.verdict !== 'kill');
        if (visible.length === 0) {
          return (
            <p className="text-white/55 py-10 text-center">
              {searching
                ? `No LinkedIn messages matching "${search.trim()}"`
                : needsReplyOnly
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

import { useState, useEffect } from 'react';

// Command = your analyst surface. Top: brains status + what the weekly LLM pass is
// NOTICING + where the ICP is moving (GET /api/insights). Below: the live board with
// draft → edit → Send (email) / Copy (LinkedIn), from GET /api/command.

const CLS_COLORS = {
  interested: 'bg-green-500/15 text-green-400 border border-green-500/20',
  cost_question: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20',
  cost_question_repeat: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20',
  more_info: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
  why_reach_out: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20',
  question_other: 'bg-orange-500/15 text-orange-400 border border-orange-500/20',
  re_engage: 'bg-purple-500/15 text-purple-400 border border-purple-500/20',
  guarantee: 'bg-coral-500/15 text-coral-400 border border-coral-500/20',
};

const chLabel = (s) => (s === 'heyreach' ? 'LinkedIn' : (s === 'instantly' || s === 'email') ? 'Email' : (s || '?'));

function Kpi({ label, value, sub, accent }) {
  return (
    <div className={`glass-card rounded-xl p-4 border-l-2 ${accent ? 'border-l-brand-500' : 'border-l-navy-border'}`}>
      <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] mb-1.5">{label}</p>
      <p className="font-serif italic text-2xl font-bold text-body leading-none">{value}</p>
      {sub && <p className="text-[11px] text-muted mt-1.5">{sub}</p>}
    </div>
  );
}

function IcpCard({ title, items, accent }) {
  const border = accent === 'brand' ? 'border-l-brand-500' : accent === 'coral' ? 'border-l-coral-500' : 'border-l-navy-border';
  if (!items || !items.length) return null;
  return (
    <div className={`glass-card rounded-xl p-4 border-l-2 ${border}`}>
      <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.14em] mb-2">{title}</p>
      <ul className="space-y-1.5">
        {items.slice(0, 5).map((it, i) => <li key={i} className="text-body/80 text-xs leading-snug">• {it}</li>)}
      </ul>
    </div>
  );
}

function BrainsDot({ brains }) {
  if (!brains) return null;
  const ok = brains.brains_ok;
  return (
    <span className={`flex items-center gap-1.5 text-xs ${ok ? 'text-emerald-400' : 'text-red-400'}`} title={brains.checked_at ? `checked ${new Date(brains.checked_at._seconds ? brains.checked_at._seconds * 1000 : brains.checked_at).toLocaleString()}` : ''}>
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`}></span>
      {ok ? 'Brains healthy' : 'Brains down — run claude setup-token'}
    </span>
  );
}

function Insights({ ins }) {
  if (!ins) {
    return (
      <div className="glass-card rounded-2xl p-6 border-l-2 border-l-navy-border">
        <h2 className="font-serif italic text-2xl font-bold text-brand-500 mb-1">What I'm noticing</h2>
        <p className="text-muted text-sm">No analysis yet — the weekly pass runs Monday, or trigger one manually.</p>
      </div>
    );
  }
  const icp = ins.icp || {};
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="font-serif italic text-2xl font-bold text-brand-500 leading-tight">What I'm noticing</h2>
        <span className="text-muted text-xs">updated {ins.date} · {ins.analyzed_count || '—'} of {ins.responder_count || '—'} responders · refreshes weekly</span>
      </div>
      <div className="glass-card rounded-2xl p-6 border-l-2 border-l-brand-500 space-y-3.5">
        {(ins.noticing || []).map((n, i) => (
          <div key={i} className="flex gap-3">
            <span className="font-serif italic text-lg font-bold text-brand-500 leading-none shrink-0">{i + 1}</span>
            <p className="text-body text-sm leading-relaxed">{n}</p>
          </div>
        ))}
      </div>
      {icp.shift && (
        <div className="glass-card rounded-xl p-4 border-l-2 border-l-brand-500 bg-brand-500/5">
          <p className="text-[10px] font-semibold text-brand-500 uppercase tracking-[0.14em] mb-1.5">ICP shift</p>
          <p className="text-body text-sm leading-relaxed">{icp.shift}</p>
        </div>
      )}
      <div className="grid md:grid-cols-3 gap-3">
        <IcpCard title="Converting" items={icp.converting} accent="brand" />
        <IcpCard title="Dead — stop sourcing" items={icp.dead} accent="muted" />
        <IcpCard title="Buying triggers" items={icp.triggers} accent="coral" />
      </div>
      {Array.isArray(ins.chase) && ins.chase.length > 0 && <IcpCard title="Chase now" items={ins.chase} accent="brand" />}
    </div>
  );
}

function BoardItem({ b, api }) {
  const [draft, setDraft] = useState(b.draft || '');
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const isEmail = (b.channel === 'instantly' || b.channel === 'email') && b.email_uuid && b.eaccount;

  const copy = () => {
    navigator.clipboard?.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const send = async () => {
    if (!isEmail || !draft.trim()) return;
    setSending(true); setError('');
    try {
      const r = await fetch(`${api}/api/instantly/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_uuid: b.email_uuid, eaccount: b.eaccount, message: draft, reply_id: b.id }),
      });
      const d = await r.json();
      if (d.success) setSent(true); else setError(d.error || 'send failed');
    } catch (e) { setError(e.message); } finally { setSending(false); }
  };

  return (
    <div className="glass-card rounded-xl p-4 border-l-2 border-l-brand-500/60 flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-serif italic text-lg font-bold text-body leading-none">{b.name}</span>
          {b.company && <span className="text-muted text-sm">· {b.company}</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5 text-muted border border-white/10">{chLabel(b.channel)}</span>
          <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md ${CLS_COLORS[b.classification] || 'bg-white/5 text-muted border border-white/10'}`}>{b.classification}</span>
          {b.hasDraft && <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-brand-500/15 text-brand-400 border border-brand-500/20">draft ready</span>}
        </div>
      </div>
      {b.reply && <p className="text-body/80 text-sm italic leading-snug">"{b.reply}"</p>}

      {sent ? (
        <p className="text-emerald-400 text-sm font-medium">✓ Sent</p>
      ) : !open ? (
        <button onClick={() => setOpen(true)} className="self-start text-xs font-semibold text-brand-400 hover:text-brand-300 transition-colors">
          {b.hasDraft ? 'Review & reply →' : 'Reply →'}
        </button>
      ) : (
        <div className="flex flex-col gap-2 pt-1">
          <textarea
            value={draft} onChange={(e) => setDraft(e.target.value)} rows={4}
            placeholder="Write a reply…"
            className="w-full bg-navy-card border border-navy-border rounded-lg p-3 text-body text-sm leading-snug focus:border-brand-500/60 outline-none resize-y"
          />
          <div className="flex items-center gap-2 flex-wrap">
            {isEmail ? (
              <button onClick={send} disabled={sending || !draft.trim()} className="glass-btn-primary rounded-lg px-4 py-1.5 text-xs font-semibold disabled:opacity-50">
                {sending ? 'Sending…' : 'Send email'}
              </button>
            ) : (
              <span className="text-[11px] text-muted">LinkedIn — paste into HeyReach to send</span>
            )}
            <button onClick={copy} className="rounded-lg px-3 py-1.5 text-xs font-semibold border border-navy-border text-body hover:border-brand-500/60 transition-all">
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button onClick={() => setOpen(false)} className="text-xs text-muted hover:text-body transition-colors">Cancel</button>
            {error && <span className="text-red-400 text-xs">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Command({ api }) {
  const [data, setData] = useState(null);
  const [insights, setInsights] = useState(null);
  const [brains, setBrains] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${api}/api/command`)
      .then((r) => {
        if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('bad');
        return r.json();
      })
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) { setErr(true); setLoading(false); } });

    fetch(`${api}/api/insights`).then((r) => r.ok ? r.json() : null).then((d) => { if (alive && d && d.success) setInsights(d.insights); }).catch(() => {});
    fetch(`${api}/api/brains`).then((r) => r.ok ? r.json() : null).then((d) => { if (alive && d && d.success) setBrains(d.status); }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  if (loading) return <p className="text-muted py-10 text-center">Loading Command…</p>;
  if (err || !data) return <p className="text-muted py-10 text-center">Command data unavailable — the backend may be waking up. Refresh in a moment.</p>;

  const { board = [], li, email, mix = {} } = data;
  const pricingObjections = (mix.cost_question || 0) + (mix.cost_question_repeat || 0) + (mix.guarantee || 0);

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif italic text-3xl font-bold text-brand-500 leading-tight">Command</h1>
          <p className="text-muted text-sm mt-1">What I'm noticing + your live board, from the real-time response store</p>
        </div>
        <BrainsDot brains={brains} />
      </div>

      <Insights ins={insights} />

      <div className="border-t border-navy-border pt-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Kpi label="Awaiting Reply" value={board.length} sub="winnable, unhandled" accent />
          {li && <Kpi label="LI Acceptance 7d" value={`${li.acceptance}%`} sub={`${li.connectionsAccepted}/${li.connectionsSent} connects`} />}
          {li && <Kpi label="LI Reply 7d" value={`${li.replyRate}%`} sub={`${li.replies}/${li.messagesSent} msgs`} />}
          {email && <Kpi label="Email Reply" value={`${email.replyRate}%`} sub={`${Number(email.sent).toLocaleString()} sent · ${email.bounceRate}% bounce`} />}
          {email && <Kpi label="Opportunities" value={email.opportunities} sub="all-time" />}
          {email && <Kpi label="Booked" value={email.booked} sub="all-time" />}
        </div>

        {pricingObjections >= 2 && (
          <div className="glass-card rounded-xl p-4 border-l-2 border-l-coral-500">
            <p className="text-[10px] font-semibold text-coral-500 uppercase tracking-[0.14em] mb-1.5">Alert</p>
            <p className="text-body text-sm">{pricingObjections} pricing / pay-to-play objections this week — the copy is still triggering "is this paid?". Reframe: earned, not bought.</p>
          </div>
        )}

        <div>
          <h2 className="font-serif text-xl font-bold text-body mb-4">The Board — {board.length} winnable awaiting you</h2>
          {board.length === 0 ? (
            <p className="text-muted text-sm">Board clear — nothing winnable awaiting a reply.</p>
          ) : (
            <div className="space-y-2.5">
              {board.map((b, i) => <BoardItem key={b.id || i} b={b} api={api} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

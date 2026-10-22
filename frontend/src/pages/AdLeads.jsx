import { useState, useEffect, useCallback } from 'react';

// Ad Leads = the "Become Impossible to Ignore" ad form leads and their
// email + text cadence (backend services/cadence.js). Import from the shared
// sheet, tag a lead to start, set the outcome after they reply, read the
// timeline. In approval mode every send waits for Vincent's tap on Telegram.

const STATE_STYLE = {
  imported: 'bg-white/5 text-white/60 border border-white/10',
  active: 'bg-green-500/15 text-green-400 border border-green-500/20',
  blocked: 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20',
  replied: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/20',
  hit_once: 'bg-blue-500/15 text-blue-400 border border-blue-500/20',
  talked_yes: 'bg-purple-500/15 text-purple-400 border border-purple-500/20',
  meeting: 'bg-brand-500/20 text-white border border-brand-500/30',
  not_interested: 'bg-white/5 text-white/40 border border-white/10',
  opted_out: 'bg-red-500/15 text-red-400 border border-red-500/20',
  done: 'bg-white/5 text-white/50 border border-white/10',
  stopped: 'bg-white/5 text-white/40 border border-white/10',
  dead: 'bg-red-500/15 text-red-400 border border-red-500/20',
};

const STATE_LABEL = {
  imported: 'Not started', active: 'In cadence', blocked: 'Blocked', replied: 'Replied: set outcome',
  hit_once: 'Hit once', talked_yes: 'Talked yes', meeting: 'Meeting booked', not_interested: 'Not interested',
  opted_out: 'Texted STOP', done: 'Cadence done', stopped: 'Stopped', dead: 'No working channel',
};

const fmt = (v) => {
  if (!v) return '';
  const d = new Date(v._seconds ? v._seconds * 1000 : v);
  return isNaN(d) ? '' : d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CT';
};

// Minimal CSV parse for the paste fallback (quoted fields ok).
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head = [], ...body] = rows.filter(r => r.some(v => v.trim()));
  const h = head.map(x => x.trim().toLowerCase());
  const col = (...names) => h.findIndex(x => names.some(n => x.includes(n)));
  const ix = { name: col('full name', 'name'), first: col('first name'), last: col('last name'), email: col('email'), phone: col('phone', 'mobile', 'cell'), role: col('role', 'title', 'describes'), fr: col('frustrat', 'challenge'), co: col('company', 'business'), rep: col('assigned'), notes: col('notes') };
  return body.map((r, i) => {
    const full = ix.name >= 0 ? r[ix.name] || '' : '';
    return {
      sheet_row: i + 2,
      email: (r[ix.email >= 0 ? ix.email : 2] || '').trim(),
      first_name: ix.first >= 0 ? r[ix.first] : full.split(' ')[0],
      last_name: ix.last >= 0 ? r[ix.last] : full.split(' ').slice(1).join(' '),
      phone: ix.phone >= 0 ? r[ix.phone] : '',
      role: ix.role >= 0 ? r[ix.role] : '',
      frustration: ix.fr >= 0 ? r[ix.fr] : '',
      company: ix.co >= 0 ? r[ix.co] : '',
      rep: ix.rep >= 0 ? r[ix.rep] : '',
      notes: ix.notes >= 0 ? r[ix.notes] : '',
    };
  });
}

// ── Funnel stats (computed from each lead's own record) ─────────────────────

const STEP_LABEL = {
  email1: 'Email 1', text_intro: 'Text intro', text1: 'Text 1', text2: 'Text 2', email2: 'Email 2', text3: 'Text 3',
  email3: 'Email 3', text4: 'Text 4', meet_confirm: 'Booked text', remind24_email: '24h email', remind24_text: '24h text',
  remind1_email: '1h email', remind1_text: '1h text', noshow: 'No-show text',
};
const secs = (v) => (v && (v._seconds ?? v.seconds)) || (v ? new Date(v).getTime() / 1000 : 0);
const pctOf = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '–');

function funnelStats(all) {
  const leads = all.filter(l => !/@storygroup\.io$/i.test(l.email || ''));
  const tagged = leads.filter(l => l.tagged_at);
  const st = {
    tagged: tagged.length,
    inCadence: tagged.filter(l => l.running).length,
    blocked: tagged.filter(l => l.running && l.blocked_reason).length,
    finished: tagged.filter(l => !l.running).length,
    sent: { email: 0, sms: 0 }, got: { email: 0, sms: 0 }, replied: { email: 0, sms: 0 },
    outcomes: { hit_once: 0, talked_yes: 0, meeting: 0, not_interested: 0 },
    problems: {
      email: leads.filter(l => l.email_bad || l.email_bounced).length,
      sms: leads.filter(l => l.sms_failed).length,
      stop: leads.filter(l => l.state === 'opted_out').length,
    },
    byStep: {},
  };
  for (const l of tagged) {
    const tl = [...(l.timeline || [])].sort((a, b) => secs(a.at) - secs(b.at));
    const got = { email: false, sms: false };
    const replied = { email: false, sms: false };
    let lastSent = null;
    for (const t of tl) {
      if (t.kind === 'sent') { st.sent[t.channel] = (st.sent[t.channel] || 0) + 1; got[t.channel] = true; lastSent = t.step; }
      if (t.kind === 'reply') {
        replied[t.channel] = true;
        const k = STEP_LABEL[lastSent] || lastSent || 'before any send';
        st.byStep[k] = (st.byStep[k] || 0) + 1;
      }
    }
    for (const ch of ['email', 'sms']) { if (got[ch]) st.got[ch]++; if (replied[ch]) st.replied[ch]++; }
    if (l.outcome in st.outcomes) st.outcomes[l.outcome]++;
  }
  return st;
}

function Stat({ label, value, sub }) {
  return (
    <div className="glass-card rounded-xl p-3 min-w-0">
      <p className="text-[10px] font-semibold text-muted uppercase tracking-[0.12em] truncate">{label}</p>
      <p className="font-serif italic text-xl font-bold text-body leading-tight mt-0.5">{value}</p>
      {sub && <p className="text-[11px] text-muted mt-0.5 leading-snug">{sub}</p>}
    </div>
  );
}

function FunnelStats({ leads }) {
  const s = funnelStats(leads);
  const replies = s.replied.email + s.replied.sms;
  const steps = Object.entries(s.byStep).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Tagged" value={s.tagged} sub={`${s.inCadence} in cadence · ${s.finished} finished${s.blocked ? ` · ${s.blocked} blocked` : ''}`} />
        <Stat label="Sent" value={s.sent.email + s.sent.sms} sub={`${s.sent.email} emails · ${s.sent.sms} texts`} />
        <Stat label="Replied" value={replies} sub={`email ${s.replied.email}/${s.got.email} (${pctOf(s.replied.email, s.got.email)}) · text ${s.replied.sms}/${s.got.sms} (${pctOf(s.replied.sms, s.got.sms)})`} />
        <Stat label="Booked" value={s.outcomes.meeting} sub={`${pctOf(s.outcomes.meeting, s.tagged)} of tagged`} />
        <Stat label="Outcomes" value={s.outcomes.hit_once + s.outcomes.talked_yes + s.outcomes.meeting + s.outcomes.not_interested}
          sub={`Hit once ${s.outcomes.hit_once} · Talked yes ${s.outcomes.talked_yes} · Meeting ${s.outcomes.meeting} · Not int. ${s.outcomes.not_interested}`} />
        <Stat label="Problems" value={s.problems.email + s.problems.sms + s.problems.stop} sub={`email bad ${s.problems.email} · texts failed ${s.problems.sms} · STOP ${s.problems.stop}`} />
      </div>
      <p className="text-[11px] text-muted">Replies by the step right before: {steps.length ? steps.map(([k, v]) => `${k} ${v}`).join(' · ') : 'no replies yet'}. Test leads (@storygroup.io) left out.</p>
    </div>
  );
}

function Btn({ children, onClick, kind = 'ghost', disabled }) {
  const cls = kind === 'primary'
    ? 'bg-brand-500 text-white hover:bg-brand-500/90'
    : kind === 'danger' ? 'text-red-300 border border-red-500/30 hover:bg-red-500/10'
    : 'text-white/70 border border-white/10 hover:bg-white/5';
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition disabled:opacity-40 ${cls}`}>{children}</button>
  );
}

function LeadRow({ lead, api, onChange, setErr }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [meetingAt, setMeetingAt] = useState('');
  const [greet, setGreet] = useState(lead.greet_name || '');
  const [hold, setHold] = useState(lead.hold_reason || '');
  const [busy, setBusy] = useState(false);

  const call = async (path, body) => {
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${api}/api/cadence/leads/${encodeURIComponent(lead.email)}/${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    } catch (e) { setErr(`${lead.first_name}: ${e.message}`); return null; } finally { setBusy(false); }
  };

  const outcome = async (o) => {
    if (o === 'meeting' && !meetingAt) { setErr('Pick the meeting date and time first.'); return; }
    if (await call('outcome', { outcome: o, meeting_at: meetingAt ? new Date(meetingAt).toISOString() : undefined })) onChange();
  };

  const timeline = [...(lead.timeline || [])].sort((a, b) => (a.at?._seconds || 0) - (b.at?._seconds || 0));
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email;

  return (
    <div className="glass-card rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="text-left flex-1 min-w-[220px]">
          <p className="font-semibold text-body">{name} <span className="text-muted text-xs font-normal">{lead.company}</span></p>
          <p className="text-[11px] text-muted">{lead.text_only ? 'no email · texts only' : lead.email}{lead.email_bounced ? ' (bounced)' : lead.email_bad ? ' (invalid)' : ''}{lead.phone ? ` · ${lead.phone}${lead.sms_failed ? ' (texts failed)' : ''}` : ' · email only'} · {lead.tz?.split('/')[1]?.replace('_', ' ')} · {lead.role}</p>
        </button>
        <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${STATE_STYLE[lead.state] || STATE_STYLE.imported}`}>{STATE_LABEL[lead.state] || lead.state}</span>
        <div className="text-[11px] text-muted min-w-[160px]">
          <div>Last: {lead.last_touch_label || '–'}</div>
          <div>Next: {lead.running ? (lead.pending_approval ? 'waiting on your tap' : lead.next_touch_label || '–') : lead.manual ? 'Manual (you)' : '–'}</div>
        </div>
        {!lead.running && !lead.manual && !['opted_out'].includes(lead.state) && lead.state !== 'replied' && (
          <Btn kind="primary" disabled={busy} onClick={async () => { if (await call('start', {})) onChange(); }}>Tag: start cadence</Btn>
        )}
      </div>
      {lead.email_check && <p className={`text-[11px] mt-1 ${lead.email_check.status === 'valid' ? 'text-green-400' : lead.email_check.status === 'invalid' ? 'text-red-400' : 'text-yellow-400'}`}>
        Clearout: {lead.email_check.status}{lead.email_check.desc ? ` (${lead.email_check.desc})` : ''} · {fmt(lead.email_check.at)}{lead.email_override === 'send' ? ' · sending anyway' : ''}</p>}
      {!lead.email_check && !lead.text_only && <p className="text-[11px] mt-1 text-yellow-400">Email not verified yet{lead.email_check_error ? `: ${lead.email_check_error}` : ''}</p>}
      {lead.email_hold && lead.email_override !== 'send' && !lead.email_bad && (
        <div className="flex items-center gap-2 mt-2 text-xs text-yellow-400">Emails on hold (Clearout not sure). Texts keep going.
          <Btn disabled={busy} onClick={async () => { if (await call('email-decision', { decision: 'send' })) onChange(); }}>Send emails anyway</Btn>
          <Btn kind="danger" disabled={busy} onClick={async () => { if (await call('email-decision', { decision: 'no' })) onChange(); }}>No emails</Btn>
        </div>
      )}
      {lead.blocked_reason && lead.running && <p className="text-xs text-yellow-400 mt-2">Blocked: {lead.blocked_reason}</p>}
      {lead.hold_reason && <p className="text-xs text-yellow-400 mt-2">On hold: {lead.hold_reason}</p>}

      {(lead.state === 'replied' || lead.running || lead.manual || open) && lead.state !== 'opted_out' && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted mr-1">Outcome</span>
          <Btn disabled={busy} onClick={() => outcome('hit_once')}>Hit once</Btn>
          <Btn disabled={busy} onClick={() => outcome('talked_yes')}>Talked yes</Btn>
          <input type="datetime-local" value={meetingAt} onChange={e => setMeetingAt(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-body" title="Meeting time (your local time)" />
          <Btn disabled={busy} onClick={() => outcome('meeting')}>Meeting yes</Btn>
          <Btn kind="danger" disabled={busy} onClick={() => outcome('not_interested')}>Not interested</Btn>
          {lead.track === 'meeting' && lead.running && <Btn disabled={busy} onClick={async () => { if (await call('noshow', {})) onChange(); }}>No-show</Btn>}
          {lead.running && <Btn kind="danger" disabled={busy} onClick={() => outcome('stop')}>Stop</Btn>}
        </div>
      )}

      {open && (
        <div className="mt-4 grid md:grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted mb-2">Timeline</p>
            <ul className="space-y-2">
              {timeline.length ? timeline.map((t, i) => (
                <li key={i} className="text-xs">
                  <span className="text-muted">{fmt(t.at)}</span>{' '}
                  <span className="font-semibold text-body/90">{t.kind}{t.step ? ` ${t.step}` : ''}{t.channel ? ` (${t.channel})` : ''}</span>
                  {t.text && <div className="text-body/70 whitespace-pre-wrap mt-0.5">{t.subject ? `Subject: ${t.subject}\n` : ''}{t.text}</div>}
                </li>
              )) : <li className="text-xs text-muted">Nothing yet.</li>}
            </ul>
          </div>
          <div className="space-y-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted mb-1">Form answers</p>
              <p className="text-xs text-body/80">Frustration: {lead.frustration || '–'}</p>
            </div>
            <div className="flex flex-wrap gap-2 items-end">
              <label className="text-xs text-muted">Email greeting name
                <input value={greet} onChange={e => setGreet(e.target.value)} placeholder={lead.first_name}
                  className="block mt-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-body" />
              </label>
              <label className="text-xs text-muted flex-1 min-w-[180px]">Hold reason (blocks Email 1)
                <input value={hold} onChange={e => setHold(e.target.value)}
                  className="block mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-body" />
              </label>
              <Btn disabled={busy} onClick={async () => { if (await call('update', { greet_name: greet, hold_reason: hold })) onChange(); }}>Save</Btn>
            </div>
            <div>
              <Btn disabled={busy} onClick={async () => setPreview(await call('preview'))}>Dry run the sequence</Btn>
              {preview && (
                <div className="mt-2 text-xs space-y-2">
                  {(preview.steps || []).map(st => (
                    <div key={st.step}>
                      <p className="text-muted">{st.label}{st.send_at ? `, ${fmt(st.send_at)}` : ''}{st.skipped ? `: skipped (${st.skipped})` : ''}</p>
                      {st.blocked && <p className="text-yellow-400">Blocked: {st.blocked}</p>}
                      {st.text && <pre className="whitespace-pre-wrap text-body/80 bg-white/5 rounded-lg p-3">{st.subject ? `Subject: ${st.subject}\n\n` : ''}{st.text}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyEditor({ api, setErr }) {
  const [steps, setSteps] = useState([]);
  const [draft, setDraft] = useState({});
  useEffect(() => { fetch(`${api}/api/cadence/copy`).then(r => r.json()).then(d => Array.isArray(d) && setSteps(d)).catch(() => {}); }, [api]);
  const save = async (s, body, subject) => {
    const r = await fetch(`${api}/api/cadence/copy/${s.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, subject }) });
    const out = await r.json();
    if (!r.ok) setErr(out.error); else { setSteps(out); setDraft({ ...draft, [s.id]: undefined }); }
  };
  return (
    <div className="glass-card rounded-xl p-4 space-y-4">
      <p className="text-xs text-muted">Drafts block their step until you approve or rewrite them. Saving a step's text approves it; clearing it goes back to the default.
        Variables: {'{first} {day} {am} {pm} {time} {today} {meeting_day} {meeting_time}'}. Every message ends in one question. No booking links.</p>
      {steps.map(s => {
        const cur = draft[s.id] || {};
        const body = cur.body ?? (s.body || s.default_template);
        const subject = cur.subject ?? s.subject;
        const tone = s.status.startsWith('draft') ? 'text-yellow-400' : 'text-green-400';
        return (
          <div key={s.id} className="border-t border-white/5 pt-3">
            <p className="text-sm font-semibold text-body">{s.label} <span className="text-muted text-xs font-normal">{s.channel === 'sms' ? 'text' : 'email'}{s.day ? ` · day ${s.day}` : ''}</span>
              <span className={`${tone} text-xs ml-2`}>{s.status}</span></p>
            {s.channel === 'email' && <input placeholder="Subject (blank = same thread)" value={subject}
              onChange={e => setDraft({ ...draft, [s.id]: { ...cur, subject: e.target.value } })}
              className="mt-2 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-body" />}
            <textarea rows={Math.min(8, body.split('\n').length + 1)} value={body}
              onChange={e => setDraft({ ...draft, [s.id]: { ...cur, body: e.target.value } })}
              className="mt-2 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-body font-mono" />
            <div className="flex gap-2 mt-1">
              {(cur.body !== undefined || cur.subject !== undefined) && <Btn kind="primary" onClick={() => save(s, body, subject)}>Save</Btn>}
              {s.status.startsWith('draft') && cur.body === undefined && <Btn kind="primary" onClick={() => save(s, s.default_template, s.subject)}>Approve as written</Btn>}
              {s.body && <Btn onClick={() => save(s, '', '')}>Back to default</Btn>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ApproveAll({ api, onDone, setErr }) {
  const [cards, setCards] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => fetch(`${api}/api/cadence/pending`).then(r => r.json()).then(d => Array.isArray(d) ? setCards(d) : setErr(d.error)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cards) return null;
  if (!cards.length) return <div className="glass-card rounded-xl p-4 text-sm text-muted">Nothing waiting for approval.</div>;
  const sendAll = async () => {
    if (!window.confirm(`Send all ${cards.length} messages? First emails go 8 to 13 minutes apart, inside each lead's send window.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`${api}/api/cadence/approve-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: cards.map(c => c.id) }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onDone(`Approved ${d.approved}; ${d.sent} sent so far, the rest go out on their gaps.`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="glass-card rounded-xl p-4 space-y-3">
      <p className="text-sm text-body font-semibold">{cards.length} waiting, in send order</p>
      {cards.map((c, i) => (
        <div key={c.id} className="text-xs">
          <p className="text-muted">{i + 1}. {c.step_label} to {c.name} · {c.channel === 'email' ? 'email' : 'text'} to {c.to}{c.times ? ` · held: ${c.times} ET` : ''}</p>
          <pre className="whitespace-pre-wrap text-body/80 bg-white/5 rounded-lg p-3 mt-1">{c.subject ? `Subject: ${c.subject}\n\n` : ''}{c.text}</pre>
        </div>
      ))}
      <Btn kind="primary" disabled={busy} onClick={sendAll}>Send all {cards.length}</Btn>
    </div>
  );
}

export default function AdLeads({ api }) {
  const [data, setData] = useState({ leads: [], mode: '' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [showCopy, setShowCopy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    fetch(`${api}/api/cadence/leads`).then(r => r.json()).then(d => d.leads && setData(d)).catch(e => setErr(e.message));
  }, [api]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const doImport = async (rows) => {
    setErr(''); setMsg('Importing…');
    const r = await fetch(`${api}/api/cadence/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows ? { rows } : {}) });
    const d = await r.json();
    if (!r.ok) { setMsg(''); setErr(`Import failed: ${d.error}. Paste the rows instead, or share the sheet with the backend.`); setShowPaste(true); return; }
    setMsg(`Imported: ${d.added} new, ${d.updated} updated${d.skipped?.length ? `, ${d.skipped.length} skipped` : ''}.`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="font-serif italic text-3xl font-bold text-body">Ad Leads</h1>
          <p className="text-xs text-muted mt-1">"Become Impossible to Ignore" form leads. Tag one to start email + text; any reply pauses it.
            Mode: <b className={data.mode === 'live' ? 'text-red-400' : 'text-green-400'}>{data.mode || '…'}</b>{data.mode === 'approval' ? ' (every send waits for your tap on Telegram)' : ''}</p>
        </div>
        <Btn kind="primary" onClick={() => doImport()}>Import from sheet</Btn>
        <Btn onClick={() => setShowPaste(!showPaste)}>Paste rows</Btn>
        <Btn onClick={() => setShowAll(!showAll)}>Approve all pending</Btn>
        <Btn onClick={() => setShowCopy(!showCopy)}>Step copy</Btn>
      </div>
      {data.leads.length > 0 && <FunnelStats leads={data.leads} />}
      {err && <p className="text-sm text-red-400">{err}</p>}
      {msg && <p className="text-sm text-green-400">{msg}</p>}
      {showPaste && (
        <div className="glass-card rounded-xl p-4">
          <p className="text-xs text-muted mb-2">Paste the sheet rows with the header row (copy straight from Google Sheets).</p>
          <textarea rows={6} value={paste} onChange={e => setPaste(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-body" />
          <Btn kind="primary" onClick={() => doImport(parseCsv(paste))}>Import pasted rows</Btn>
        </div>
      )}
      {showAll && <ApproveAll api={api} setErr={setErr} onDone={m => { setMsg(m); setShowAll(false); load(); }} />}
      {showCopy && <CopyEditor api={api} setErr={setErr} />}
      <div className="space-y-3">
        {data.leads.map(l => <LeadRow key={l.email} lead={l} api={api} onChange={load} setErr={setErr} />)}
        {!data.leads.length && <p className="text-sm text-muted">No ad leads yet. Import from the sheet.</p>}
      </div>
    </div>
  );
}

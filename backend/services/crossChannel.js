/**
 * Cross-channel stop.
 *
 * A prospect who is in both an Instantly email campaign and a HeyReach LinkedIn
 * campaign should stop hearing from us on the other channel once they reply on
 * one. Instantly and HeyReach each stop their own sequence on a reply; nothing
 * connected the two until this file.
 *
 *   LinkedIn reply -> stop the lead in the paired Instantly campaign
 *   Email reply    -> stop the lead in the paired HeyReach campaign
 *
 * Safety:
 *   CROSS_CHANNEL_STOP   off (default) | shadow (log what it would stop) | live
 *   CROSS_CHANNEL_PAIRS  allowlist "instantlyCampaignId:heyreachCampaignId",
 *                        comma separated. Nothing outside a listed pair is
 *                        ever touched, and the pair is re-read from env on
 *                        every event, so removing it switches its links off.
 *   CROSS_CHANNEL_ACCEPT off (default) | on. Only records that a connection
 *                        request was accepted. It never sends anything.
 *   CROSS_CHANNEL_HOLD_LIST_ID  optional Instantly lead list that stopped leads
 *                        are moved to. Live mode finds or creates one by name
 *                        when this is empty.
 *
 * How each side is stopped (checked against both vendors' API docs 2026-11-17):
 *   Instantly has no "pause one lead" call. The lead is moved out of the
 *   campaign into a holding lead list (POST /leads/move with its id, the source
 *   campaign and limit 1), so the record and its history are kept and it can be
 *   moved back. Nothing is deleted. A copy of the lead is saved on the link
 *   first.
 *   HeyReach: POST /campaign/StopLeadInCampaign {campaignId, leadMemberId,
 *   leadUrl}. The lead stays in the campaign, marked stopped.
 *
 * Every decision writes a row to the `logs` collection (type cross_channel).
 * Nothing in here throws: the reply webhooks must keep working whatever
 * happens.
 */
const crypto = require('crypto');
const axios = require('axios');

const HEYREACH_BASE = 'https://api.heyreach.io/api/public';
const LINKS = 'channel_links';
const HOLD_LIST_NAME = 'Cross-channel stop | replied on LinkedIn';

// ---------- config (read lazily so .env changes apply on restart only) ----------

function mode() {
  const m = String(process.env.CROSS_CHANNEL_STOP || 'off').trim().toLowerCase();
  return m === 'live' || m === 'shadow' ? m : 'off';
}

function pairs() {
  return String(process.env.CROSS_CHANNEL_PAIRS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const i = s.lastIndexOf(':');
      if (i < 1) return null;
      const instantly = s.slice(0, i).trim().toLowerCase();
      const heyreach = s.slice(i + 1).trim();
      if (!instantly || !/^\d+$/.test(heyreach)) return null;
      return { instantly, heyreach };
    })
    .filter(Boolean);
}

function isAllowedPair(instantlyId, heyreachId) {
  const a = String(instantlyId || '').toLowerCase();
  const b = String(heyreachId || '');
  if (!a || !b) return false;
  return pairs().some(p => p.instantly === a && p.heyreach === b);
}

function acceptTracking() {
  return String(process.env.CROSS_CHANNEL_ACCEPT || 'off').trim().toLowerCase() === 'on';
}

// ---------- normalizers ----------

/**
 * One key per LinkedIn profile, whatever the export looked like.
 *   https://www.linkedin.com/in/Jane-Doe-123/?utm=x  -> in/jane-doe-123
 *   https://linkedin.com/sales/lead/ACwAAB...,NAME   -> sales/acwaab...
 * A member-id URL (/in/ACoAA...) and a vanity URL for the same person give
 * different keys. That case falls back to name plus company.
 */
function linkedinKey(url) {
  if (!url) return '';
  let s = String(url).trim();
  try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
  s = s.toLowerCase().split('?')[0].split('#')[0].replace(/\/+$/, '');
  const m = s.match(/linkedin\.com\/(in|pub|sales\/lead|sales\/people|talent\/profile)\/([^/]+)/);
  if (!m) return '';
  const id = m[2].split(',')[0].trim();
  if (!id) return '';
  return (m[1].startsWith('sales') ? 'sales/' : 'in/') + id;
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'sir', 'rev']);
const CREDENTIALS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'md', 'cpa', 'esq', 'pe', 'cfa', 'cfp', 'pmp', 'jd', 'rn', 'dds', 'dmd']);

function cleanNamePart(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(',')[0]                       // "Smith, MBA" -> "Smith"
    .replace(/\(.*?\)/g, ' ')            // nicknames in brackets
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/['-]/g, '')
    .split(/\s+/)
    .filter(t => t && !HONORIFICS.has(t) && !CREDENTIALS.has(t))
    .join(' ');
}

function nameKey(first, last) {
  const f = cleanNamePart(first);
  const l = cleanNamePart(last);
  if (!f || !l) return '';
  return `${f.split(' ')[0]}|${l}`;
}

const COMPANY_NOISE = new Set(['inc', 'llc', 'corp', 'corporation', 'ltd', 'co', 'company', 'lp', 'llp', 'plc', 'gmbh', 'the', 'pllc', 'pc', 'incorporated', 'limited']);

function companyKey(name) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !COMPANY_NOISE.has(t))
    .join(' ');
}

// Same company when the cleaned names are equal, or one is the start of the
// other ("acme" vs "acme roofing"). A blank on either side is never a match.
function sameCompany(a, b) {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && (long.startsWith(short + ' ') || long.endsWith(' ' + short));
}

function cleanEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

function linkId(instantlyId, heyreachId, email) {
  return crypto.createHash('sha1').update(`${instantlyId}|${heyreachId}|${email}`).digest('hex').slice(0, 32);
}

// ---------- link store (Firestore) ----------

function firestoreStore() {
  const { db } = require('./db');
  const col = () => db.collection(LINKS);
  const rows = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return {
    async byLinkedinKey(key) { return key ? rows(await col().where('linkedin_key', '==', key).limit(20).get()) : []; },
    async byEmail(email) { return email ? rows(await col().where('email', '==', email).limit(20).get()) : []; },
    async byNameKey(key) { return key ? rows(await col().where('name_key', '==', key).limit(50).get()) : []; },
    async upsertMany(docs) {
      for (let i = 0; i < docs.length; i += 400) {
        const batch = db.batch();
        for (const d of docs.slice(i, i + 400)) {
          const { id, ...data } = d;
          batch.set(col().doc(id), data, { merge: true });
        }
        await batch.commit();
      }
    },
    async patch(id, data) { await col().doc(id).set({ ...data, updated_at: new Date() }, { merge: true }); },
    async countForPair(instantlyId, heyreachId) {
      const snap = await col().where('heyreach_campaign_id', '==', String(heyreachId)).count().get();
      return snap.data().count;
    },
  };
}

// ---------- vendor calls ----------

function heyreachHeaders() {
  const key = process.env.HEYREACH_API_KEY;
  if (!key) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': key, 'Content-Type': 'application/json' };
}

function realApi() {
  const instantly = require('./instantly');
  return {
    // Read only. The lead as Instantly has it inside this one campaign.
    findInstantlyLead: (email, campaignId) => instantly.findLeadInCampaign(email, campaignId),
    holdListId: async () => {
      const fixed = String(process.env.CROSS_CHANNEL_HOLD_LIST_ID || '').trim();
      return fixed || instantly.findOrCreateLeadList(HOLD_LIST_NAME);
    },
    moveInstantlyLead: (leadId, campaignId, listId) => instantly.moveLeadToList(leadId, campaignId, listId),
    // Read only. HeyReach's numeric member id for a profile URL.
    heyreachLead: async (profileUrl) => {
      const r = await axios.post(`${HEYREACH_BASE}/lead/GetLead`, { profileUrl }, { headers: heyreachHeaders(), timeout: 20000 });
      return r.data || null;
    },
    stopHeyreachLead: async ({ campaignId, memberId, profileUrl }) => {
      const r = await axios.post(`${HEYREACH_BASE}/campaign/StopLeadInCampaign`,
        { campaignId: Number(campaignId), leadMemberId: String(memberId), leadUrl: profileUrl },
        { headers: heyreachHeaders(), timeout: 20000 });
      return { status: r.status };
    },
  };
}

function resolveDeps(deps = {}) {
  return {
    store: deps.store || firestoreStore(),
    api: deps.api || realApi(),
    log: deps.log || (async (row) => { const { addLog } = require('./db'); await addLog('cross_channel', row); }),
  };
}

// ---------- link upsert ----------

/**
 * Save or update links for one campaign pair.
 * rows: [{ email, linkedinUrl, firstName, lastName, company }]
 * A row needs a valid email and a LinkedIn profile URL; anything else is
 * skipped and counted, never guessed.
 */
async function upsertLinks(rows, { instantlyCampaignId, heyreachCampaignId, source = 'bulk' } = {}, deps) {
  const { store } = resolveDeps(deps);
  const inst = String(instantlyCampaignId || '').trim().toLowerCase();
  const hr = String(heyreachCampaignId || '').trim();
  if (!isAllowedPair(inst, hr)) {
    throw new Error('That campaign pair is not in CROSS_CHANNEL_PAIRS');
  }
  const now = new Date();
  const docs = [];
  const skipped = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const email = cleanEmail(r && (r.email || r.Email));
    const url = String((r && (r.linkedinUrl || r.linkedin_url || r.profileUrl || r.profile_url)) || '').trim();
    const key = linkedinKey(url);
    if (!email) { skipped.push({ reason: 'no valid email', linkedinUrl: url || null }); continue; }
    if (!key) { skipped.push({ reason: 'no LinkedIn profile URL', email }); continue; }
    if (seen.has(email)) { skipped.push({ reason: 'duplicate email in this upload', email }); continue; }
    seen.add(email);
    const first = String(r.firstName || r.first_name || '').trim();
    const last = String(r.lastName || r.last_name || '').trim();
    const company = String(r.company || r.companyName || r.company_name || '').trim();
    docs.push({
      id: linkId(inst, hr, email),
      email,
      linkedin_url: url,
      linkedin_key: key,
      first_name: first,
      last_name: last,
      name_key: nameKey(first, last),
      company,
      company_key: companyKey(company),
      instantly_campaign_id: inst,
      heyreach_campaign_id: hr,
      source,
      updated_at: now,
    });
  }
  if (docs.length) await store.upsertMany(docs);
  return { saved: docs.length, skipped };
}

// ---------- matching ----------

const allowed = links => links.filter(l => isAllowedPair(l.instantly_campaign_id, l.heyreach_campaign_id));

/**
 * Find the link(s) for a LinkedIn profile. URL first; on a miss, first plus
 * last name plus company, and only when that points at exactly one person.
 */
async function matchLinkedIn({ profileUrl, firstName, lastName, company }, store) {
  const key = linkedinKey(profileUrl);
  const byUrl = allowed(await store.byLinkedinKey(key));
  if (byUrl.length) return { links: byUrl, match: 'url' };

  const nk = nameKey(firstName, lastName);
  if (!nk) return { links: [], match: 'none' };
  const sameName = allowed(await store.byNameKey(nk));
  if (!sameName.length) return { links: [], match: 'none' };
  const sameCo = sameName.filter(l => sameCompany(l.company, company) || sameCompany(l.company_alt, company));
  // The same person can sit in two pairs; that is still one person.
  const people = new Set(sameCo.map(l => l.email));
  if (people.size === 1) return { links: sameCo, match: 'name_company' };
  if (people.size > 1) return { links: [], match: 'ambiguous', candidates: sameCo.length };
  return { links: [], match: 'name_only', candidates: sameName.length };
}

const who = (l, extra = {}) => ({
  name: [l.first_name, l.last_name].filter(Boolean).join(' ') || extra.name || '',
  email: l.email || null,
  linkedin_url: l.linkedin_url || extra.linkedin_url || null,
  company: l.company || extra.company || '',
});

const errText = e => {
  const body = e && e.response && e.response.data;
  const detail = body ? (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300) : '';
  return [e && e.message, detail].filter(Boolean).join(' | ');
};

async function safeLog(log, row) {
  try { await log({ ...row, at: new Date().toISOString() }); }
  catch (e) { console.warn('[cross-channel] log write failed:', e.message); }
  const w = row.who || {};
  console.log(`[cross-channel] ${row.mode} ${row.trigger_channel} -> ${row.action}: ${row.outcome} (${w.name || w.email || w.linkedin_url || 'unknown'})${row.reason ? ' ' + row.reason : ''}`);
  return row;
}

// ---------- LinkedIn reply -> stop email ----------

/**
 * @param evt { profileUrl, firstName, lastName, company, memberId,
 *              heyreachCampaignId, replyId, conversationId, simulated }
 * @returns { mode, results: [log rows] }. Never throws.
 */
async function onLinkedInReply(evt = {}, deps) {
  const m = evt.simulated ? 'shadow' : mode();
  if (mode() === 'off' && !evt.simulated) return { mode: 'off', results: [] };
  const results = [];
  let d;
  try { d = resolveDeps(deps); } catch (e) { console.warn('[cross-channel] setup failed:', e.message); return { mode: m, results }; }
  const base = {
    mode: m,
    trigger_channel: 'linkedin',
    action: 'stop_email',
    trigger: {
      heyreach_campaign_id: evt.heyreachCampaignId ? String(evt.heyreachCampaignId) : null,
      reply_id: evt.replyId || null,
      conversation_id: evt.conversationId || null,
    },
    ...(evt.simulated ? { simulated: true } : {}),
  };
  const fromEvt = {
    name: [evt.firstName, evt.lastName].filter(Boolean).join(' '),
    linkedin_url: evt.profileUrl || null,
    company: evt.company || '',
  };
  try {
    const found = await matchLinkedIn(evt, d.store);
    if (!found.links.length) {
      const inPair = pairs().some(p => p.heyreach === String(evt.heyreachCampaignId || ''));
      // Replies from people who were never in a paired campaign are not ours
      // to act on and are not logged. These three are worth a look.
      if (found.match === 'ambiguous') {
        results.push(await safeLog(d.log, { ...base, outcome: 'no_action', reason: `URL did not match and ${found.candidates} links share this name and company. Stop the email by hand if this is one of them.`, who: { ...fromEvt, email: null }, manual_check: true }));
      } else if (found.match === 'name_only') {
        results.push(await safeLog(d.log, { ...base, outcome: 'no_action', reason: 'URL did not match. The name matches a link but the company does not, so nothing was stopped.', who: { ...fromEvt, email: null }, manual_check: true }));
      } else if (inPair) {
        results.push(await safeLog(d.log, { ...base, outcome: 'no_link', reason: 'Reply came from a paired LinkedIn campaign but this person has no email link on file.', who: { ...fromEvt, email: null }, manual_check: true }));
      }
      return { mode: m, results };
    }

    for (const link of found.links) {
      const row = {
        ...base,
        match: found.match,
        who: who(link, fromEvt),
        instantly_campaign_id: link.instantly_campaign_id,
        heyreach_campaign_id: link.heyreach_campaign_id,
        link_id: link.id,
      };
      try {
        if (!evt.simulated) {
          // Keep the member id HeyReach sent; the other direction needs it.
          const seen = { linkedin_replied_at: new Date() };
          if (evt.memberId && !link.linkedin_member_id) seen.linkedin_member_id = String(evt.memberId);
          await d.store.patch(link.id, seen).catch(() => {});
        }
        if (m === 'live' && link.email_stopped_at) { results.push({ ...row, outcome: 'already_stopped' }); continue; }
        if (m === 'shadow' && link.shadow_email_stop_at && !evt.simulated) { results.push({ ...row, outcome: 'already_recorded' }); continue; }

        let lead = null;
        let lookupError = null;
        try { lead = await d.api.findInstantlyLead(link.email, link.instantly_campaign_id); }
        catch (e) { lookupError = errText(e); }
        const leadInfo = lead
          ? { found: true, id: lead.id, status: lead.status ?? null, replies: lead.email_reply_count ?? null, last_step: lead.last_step_id ?? null }
          : { found: false, ...(lookupError ? { lookup_error: lookupError } : {}) };

        if (m === 'shadow') {
          results.push(await safeLog(d.log, {
            ...row,
            outcome: 'would_stop',
            would: `Move ${link.email} out of Instantly campaign ${link.instantly_campaign_id} into the holding list`,
            instantly_lead: leadInfo,
            ...(lead ? {} : { note: lookupError ? 'Could not check Instantly for this lead.' : 'Lead is not in the Instantly campaign right now, so live mode would have had nothing to stop.' }),
          }));
          if (!evt.simulated) await d.store.patch(link.id, { shadow_email_stop_at: new Date() }).catch(() => {});
          continue;
        }

        // live
        if (lookupError) throw new Error(`Instantly lookup failed: ${lookupError}`);
        if (!lead) {
          results.push(await safeLog(d.log, { ...row, outcome: 'not_in_campaign', reason: 'Lead is not in the Instantly campaign, nothing to stop.', instantly_lead: leadInfo }));
          continue;
        }
        await d.store.patch(link.id, { instantly_snapshot: JSON.parse(JSON.stringify(lead)), instantly_snapshot_at: new Date() });
        const listId = await d.api.holdListId();
        if (!listId) throw new Error('No holding list id');
        const job = await d.api.moveInstantlyLead(lead.id, link.instantly_campaign_id, listId);
        await d.store.patch(link.id, { email_stopped_at: new Date(), email_stopped_by: 'linkedin_reply', instantly_hold_list_id: listId });
        results.push(await safeLog(d.log, {
          ...row,
          outcome: 'stopped',
          did: `Moved ${link.email} out of Instantly campaign ${link.instantly_campaign_id} into holding list ${listId}`,
          instantly_lead: leadInfo,
          instantly_job_id: (job && (job.id || job.job_id)) || null,
        }));
      } catch (e) {
        results.push(await safeLog(d.log, { ...row, outcome: 'error', reason: errText(e), manual_check: m === 'live' }));
      }
    }
  } catch (e) {
    results.push(await safeLog(d.log, { ...base, outcome: 'error', reason: errText(e), who: { ...fromEvt, email: null } }));
  }
  return { mode: m, results };
}

// ---------- Email reply -> stop LinkedIn ----------

const AUTO_REPLY = new Set(['ooo', 'bounce']);

/**
 * @param evt { email, classification, classifierFailed, instantlyCampaignId,
 *              replyId, simulated }
 * @returns { mode, results: [log rows] }. Never throws.
 */
async function onEmailReply(evt = {}, deps) {
  const m = evt.simulated ? 'shadow' : mode();
  if (mode() === 'off' && !evt.simulated) return { mode: 'off', results: [] };
  const results = [];
  let d;
  try { d = resolveDeps(deps); } catch (e) { console.warn('[cross-channel] setup failed:', e.message); return { mode: m, results }; }
  const email = cleanEmail(evt.email);
  const cls = String(evt.classification || '').toLowerCase();
  const base = {
    mode: m,
    trigger_channel: 'email',
    action: 'stop_linkedin',
    trigger: {
      instantly_campaign_id: evt.instantlyCampaignId ? String(evt.instantlyCampaignId).toLowerCase() : null,
      reply_id: evt.replyId || null,
      classification: cls || null,
    },
    ...(evt.simulated ? { simulated: true } : {}),
  };
  try {
    if (!email) return { mode: m, results };
    const links = allowed(await d.store.byEmail(email));
    if (!links.length) {
      const inPair = pairs().some(p => p.instantly === base.trigger.instantly_campaign_id);
      if (inPair && !AUTO_REPLY.has(cls)) {
        results.push(await safeLog(d.log, { ...base, outcome: 'no_link', reason: 'Reply came from a paired email campaign but this address has no LinkedIn link on file.', who: { name: '', email, linkedin_url: null, company: '' }, manual_check: true }));
      }
      return { mode: m, results };
    }

    for (const link of links) {
      const row = {
        ...base,
        match: 'email',
        who: who(link),
        instantly_campaign_id: link.instantly_campaign_id,
        heyreach_campaign_id: link.heyreach_campaign_id,
        link_id: link.id,
      };
      try {
        // Only a real person replying stops LinkedIn. Out of office and
        // bounces do not, and an unread reply (classifier down) is left for a
        // person to judge.
        if (AUTO_REPLY.has(cls)) {
          results.push(await safeLog(d.log, { ...row, outcome: 'skipped', reason: `Reply was classified ${cls}, not a person. LinkedIn left running.` }));
          continue;
        }
        if (evt.classifierFailed || !cls) {
          results.push(await safeLog(d.log, { ...row, outcome: 'skipped', reason: 'The reply could not be classified, so it may be an auto-reply. Check it and stop LinkedIn by hand if it is a real reply.', manual_check: true }));
          continue;
        }
        if (!evt.simulated) await d.store.patch(link.id, { email_replied_at: new Date() }).catch(() => {});
        // Set by scripts/crosschannel-sync.js: this person gets the email but is
        // not in the paired LinkedIn campaign (usually because another HeyReach
        // campaign already has them), so there is nothing here to stop.
        if (link.on_linkedin === false) {
          results.push(await safeLog(d.log, { ...row, outcome: 'skipped', reason: 'This person is not in the paired LinkedIn campaign. If another HeyReach campaign is messaging them, stop them there by hand.', manual_check: true }));
          continue;
        }
        if (m === 'live' && link.linkedin_stopped_at) { results.push({ ...row, outcome: 'already_stopped' }); continue; }
        if (m === 'shadow' && link.shadow_linkedin_stop_at && !evt.simulated) { results.push({ ...row, outcome: 'already_recorded' }); continue; }

        let memberId = link.linkedin_member_id || null;
        let lookupError = null;
        if (!memberId) {
          try {
            const hl = await d.api.heyreachLead(link.linkedin_url);
            memberId = hl && (hl.linkedin_id || hl.linkedinId) ? String(hl.linkedin_id || hl.linkedinId) : null;
          } catch (e) { lookupError = errText(e); }
        }
        const hrInfo = { member_id: memberId, ...(lookupError ? { lookup_error: lookupError } : {}) };

        if (m === 'shadow') {
          results.push(await safeLog(d.log, {
            ...row,
            outcome: 'would_stop',
            would: `Stop ${link.linkedin_url} in HeyReach campaign ${link.heyreach_campaign_id}`,
            heyreach_lead: hrInfo,
            ...(memberId ? {} : { note: 'HeyReach did not return a member id for this profile, so live mode would have logged it for a manual stop.' }),
          }));
          if (!evt.simulated) await d.store.patch(link.id, { shadow_linkedin_stop_at: new Date(), ...(memberId ? { linkedin_member_id: memberId } : {}) }).catch(() => {});
          continue;
        }

        // live
        if (!memberId) {
          results.push(await safeLog(d.log, { ...row, outcome: 'manual_stop_needed', reason: `HeyReach has no member id for this profile${lookupError ? ` (${lookupError})` : ''}. Stop this lead in the HeyReach campaign by hand.`, heyreach_lead: hrInfo, manual_check: true }));
          continue;
        }
        await d.api.stopHeyreachLead({ campaignId: link.heyreach_campaign_id, memberId, profileUrl: link.linkedin_url });
        await d.store.patch(link.id, { linkedin_stopped_at: new Date(), linkedin_stopped_by: 'email_reply', linkedin_member_id: memberId });
        results.push(await safeLog(d.log, {
          ...row,
          outcome: 'stopped',
          did: `Stopped ${link.linkedin_url} in HeyReach campaign ${link.heyreach_campaign_id}`,
          heyreach_lead: hrInfo,
        }));
      } catch (e) {
        results.push(await safeLog(d.log, { ...row, outcome: 'error', reason: errText(e), manual_check: m === 'live' }));
      }
    }
  } catch (e) {
    results.push(await safeLog(d.log, { ...base, outcome: 'error', reason: errText(e), who: { name: '', email: email || null, linkedin_url: null, company: '' } }));
  }
  return { mode: m, results };
}

// ---------- Connection accepted (built, off) ----------

/**
 * Marks the link as accepted on LinkedIn. That is all it does: no email, no
 * stop. HeyReach is not sending this event (no CONNECTION_REQUEST_ACCEPTED
 * webhook is registered) and CROSS_CHANNEL_ACCEPT is off by default.
 */
async function onConnectionAccepted(evt = {}, deps) {
  if (!acceptTracking() || mode() === 'off') return { tracked: false, reason: 'accept tracking is off' };
  try {
    const d = resolveDeps(deps);
    const found = await matchLinkedIn(evt, d.store);
    if (!found.links.length) return { tracked: false, reason: `no link (${found.match})` };
    for (const link of found.links) {
      const patch = { linkedin_accepted_at: new Date() };
      if (evt.memberId && !link.linkedin_member_id) patch.linkedin_member_id = String(evt.memberId);
      await d.store.patch(link.id, patch);
      await safeLog(d.log, {
        mode: mode(), trigger_channel: 'linkedin', action: 'mark_accepted', outcome: 'recorded', match: found.match,
        who: who(link), instantly_campaign_id: link.instantly_campaign_id, heyreach_campaign_id: link.heyreach_campaign_id, link_id: link.id,
      });
    }
    return { tracked: true, links: found.links.length };
  } catch (e) {
    console.warn('[cross-channel] accept tracking failed:', e.message);
    return { tracked: false, reason: e.message };
  }
}

module.exports = {
  mode, pairs, isAllowedPair, acceptTracking,
  linkedinKey, nameKey, companyKey, sameCompany, cleanEmail,
  upsertLinks, matchLinkedIn, linkId,
  onLinkedInReply, onEmailReply, onConnectionAccepted,
  firestoreStore, LINKS, HOLD_LIST_NAME,
};

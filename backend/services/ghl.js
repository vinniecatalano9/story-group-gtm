// Go High Level (GHL), the CRM replacing Nutshell (Vincent, 2026-11-09).
//
// Mirrors services/nutshell.js so each automation can switch one at a time:
//   CRM_PROVIDER=nutshell|ghl            the default for everything
//   CRM_PROVIDER_<AREA>=nutshell|ghl     one area: SCORECARD, CADENCE, FEED, INTAKE, STRIPE
// Nothing here runs until an area is switched to ghl AND the keys are set.
//
// The pipeline is config, not code (the API can't create pipelines, and the
// real one isn't decided yet):
//   GHL_PIPELINE          pipeline name (default "Story Group Sales Pipeline")
//   GHL_STAGES            JSON, role -> stage name, merged over STAGE_DEFAULTS
//   GHL_INTAKE_PIPELINES  comma list of pipeline names the intake watches (default: GHL_PIPELINE)
// A role whose stage doesn't exist is skipped with a line saying so, never guessed.
//
// GHL facts (checked live and against the docs, 11/9): one open-or-closed
// opportunity per contact per pipeline (a second create returns 400
// OPPORTUNITY_NO_DUPLICATE with meta.existingId); notes live on the contact;
// a duplicate contact create returns 400 with meta.contactId; 100 requests
// per 10 seconds.

const BASE = 'https://services.leadconnectorhq.com';
const API_KEY = () => process.env.GHL_API_KEY;
const LOCATION = () => process.env.GHL_LOCATION_ID;
const isConfigured = () => !!(API_KEY() && LOCATION());

/** Is this area on GHL? Areas: scorecard, cadence, feed, intake, stripe. */
function on(area) {
  const v = (area && process.env[`CRM_PROVIDER_${String(area).toUpperCase()}`]) || process.env.CRM_PROVIDER || 'nutshell';
  return /^ghl$/i.test(v.trim()) && isConfigured();
}

// GHL user ids (GET /users, 2026-11-09), keyed by email like nutshell.USERS.
const USERS = {
  'vincent@storygroup.io': '9esmhmQd4qnDiZYD4fgf',
  'aaron@storygroup.io': '7pQcn0Cg2kN6WXPW8Q18',
  'mmoonan@storygroup.io': 'C4SvMUYCJ3ysq1bBHQqD',
  'mckenna@storygroup.io': 'C4SvMUYCJ3ysq1bBHQqD',
  'michelle@storygroup.io': 'QhaS4saydjNNJDT6OFVY',
  'annette@storygroup.io': 'UJwbw9ekSLfvSSbl4ydF',
  'lydia@storygroup.io': 'zZAo293eHB6ebmzYByUY',
  'amanda@storygroup.io': 'eSDfelL8ohS5XmrEk8uG',
};
const USER_NAMES = {
  '9esmhmQd4qnDiZYD4fgf': 'Vincent Catalano', '7pQcn0Cg2kN6WXPW8Q18': 'Aaron Evans', C4SvMUYCJ3ysq1bBHQqD: 'McKenna Moonan',
  QhaS4saydjNNJDT6OFVY: 'Michelle Brown', UJwbw9ekSLfvSSbl4ydF: 'Annette Fildisis', zZAo293eHB6ebmzYByUY: 'Lydia Fisher', eSDfelL8ohS5XmrEk8uG: 'Amanda Hall',
};
const ME = () => process.env.GHL_USER_ID || USERS['vincent@storygroup.io'];
const userName = id => USER_NAMES[id] || 'another rep';

async function api(method, path, body, { attempts = 3, timeoutMs = 30000 } = {}) {
  if (!isConfigured()) throw new Error('GHL_API_KEY or GHL_LOCATION_ID is not set on the server');
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${API_KEY()}`, Version: '2021-07-28', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
      if (res.ok) return data;
      const err = new Error(`GHL ${method} ${path.split('?')[0]} HTTP ${res.status}: ${String((data && data.message) || text).slice(0, 200)}`);
      err.status = res.status;
      err.data = data;
      // 4xx is an answer, not an outage (429 aside): don't retry it.
      if (res.status < 500 && res.status !== 429) throw err;
      lastErr = err;
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
    console.warn(`[ghl] ${method} ${path.split('?')[0]} attempt ${i + 1} failed: ${lastErr.message}`);
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  throw lastErr;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

// ── Pipeline and stages (config) ─────────────────────────────────────────────

// Role -> stage name. Roles are what the automations ask for; names are
// whatever the pipeline in GHL calls them. Override with GHL_STAGES.
const STAGE_DEFAULTS = {
  new: 'New Funnel Lead',          // a fresh ad or scorecard lead
  contacted: 'Contacted',          // any sent step or a Hit once call
  qualified: 'Strategy Call Booked', // Talked yes
  meeting: 'Strategy Call Booked', // meeting booked
  unqualified: 'Unqualified',      // closed as Not a strategic fit
  lost: 'Closed Lost',
  won: 'Closed Won',
};
function stageNames() {
  try { return { ...STAGE_DEFAULTS, ...JSON.parse(process.env.GHL_STAGES || '{}') }; } catch { console.warn('[ghl] GHL_STAGES is not valid JSON, using defaults'); return STAGE_DEFAULTS; }
}
const pipelineName = () => process.env.GHL_PIPELINE || 'Story Group Sales Pipeline';

let _pipes = { at: 0, list: null };
async function pipelines({ fresh = false } = {}) {
  if (!fresh && _pipes.list && Date.now() - _pipes.at < 10 * 6e4) return _pipes.list;
  const d = await api('GET', `/opportunities/pipelines?${qs({ locationId: LOCATION() })}`);
  _pipes = { at: Date.now(), list: d.pipelines || [] };
  return _pipes.list;
}

/** The configured pipeline: { id, name, stages: [{ id, name, position }] }. Throws if it isn't in GHL. */
async function pipeline() {
  const p = (await pipelines()).find(x => norm(x.name) === norm(pipelineName()));
  if (!p) throw new Error(`GHL has no pipeline named "${pipelineName()}" (set GHL_PIPELINE)`);
  return { id: p.id, name: p.name, stages: (p.stages || []).map((s, i) => ({ id: s.id, name: s.name, position: s.position == null ? i : s.position })) };
}

/** The stage for a role in the configured pipeline, or null when the pipeline has no such stage. */
async function stageFor(role) {
  const p = await pipeline();
  const want = stageNames()[role];
  return (want && p.stages.find(s => norm(s.name) === norm(want))) || null;
}

/** Every role and whether its stage exists: the pre-flight check before switching an area on. */
async function checkConfig() {
  const out = { configured: isConfigured(), pipeline: null, stages: {}, missing: [], lost_reasons: [] };
  if (!out.configured) return out;
  const p = await pipeline();
  out.pipeline = p.name;
  for (const [role, name] of Object.entries(stageNames())) {
    const s = p.stages.find(x => norm(x.name) === norm(name));
    out.stages[role] = s ? s.name : null;
    if (!s) out.missing.push(`${role} -> "${name}"`);
  }
  out.lost_reasons = (await lostReasons()).map(r => r.name);
  return out;
}

// ── Contacts, companies, notes ───────────────────────────────────────────────

async function searchContacts(filters, pageLimit = 5) {
  const d = await api('POST', '/contacts/search', { locationId: LOCATION(), pageLimit, filters });
  return d.contacts || [];
}

/** A contact by email, then phone (E.164), then exact name. Returns the contact or null. */
async function findContact({ email, phone, name } = {}) {
  // The duplicate lookup is immediate; the search index lags a new contact by 10+ seconds.
  for (const [k, v] of [['email', email && String(email).toLowerCase()], ['number', phone]]) {
    if (!v) continue;
    const d = await api('GET', `/contacts/search/duplicate?${qs({ locationId: LOCATION(), [k]: v })}`).catch(() => null);
    if (d && d.contact && d.contact.id) return d.contact;
  }
  if (email) {
    const hit = (await searchContacts([{ field: 'email', operator: 'eq', value: String(email).toLowerCase() }]))[0];
    if (hit) return hit;
  }
  if (phone) {
    const hit = (await searchContacts([{ field: 'phone', operator: 'eq', value: phone }]))[0];
    if (hit) return hit;
  }
  if (!email && !phone && name) {
    const d = await api('GET', `/contacts/?${qs({ locationId: LOCATION(), query: name, limit: 10 })}`);
    return (d.contacts || []).find(c => norm(c.contactName || `${c.firstName || ''} ${c.lastName || ''}`) === norm(name)) || null;
  }
  return null;
}

/** Same contract as nutshell.findOrCreateContact: { id, created } or null. */
async function findOrCreateContact({ name, email, phone, title, company, businessId, assignedTo, source, tags } = {}) {
  const hit = await findContact({ email, phone, name });
  if (hit) return { id: hit.id, created: false, contact: hit };
  if (!name && !email && !phone) return null;
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const body = { locationId: LOCATION() };
  if (parts.length) { body.firstName = parts[0]; if (parts.length > 1) body.lastName = parts.slice(1).join(' '); }
  if (email) body.email = String(email).toLowerCase();
  if (phone) body.phone = phone;
  if (company) body.companyName = company;
  if (assignedTo) body.assignedTo = assignedTo;
  if (source) body.source = source;
  if (tags && tags.length) body.tags = tags;
  try {
    const made = await api('POST', '/contacts/', body);
    const id = made.contact && made.contact.id;
    if (id && businessId) await api('POST', '/contacts/bulk/business', { locationId: LOCATION(), ids: [id], businessId }).catch(e => console.warn('[ghl] link business failed:', e.message));
    if (id && title) await addNote(id, `Title: ${title}`).catch(() => {});
    return { id, created: true, contact: made.contact };
  } catch (e) {
    // GHL matched it to someone the search missed (other email on file, phone format).
    const existing = e.data && e.data.meta && e.data.meta.contactId;
    if (existing) return { id: existing, created: false };
    throw e;
  }
}

async function getContact(contactId) {
  return (await api('GET', `/contacts/${contactId}`)).contact || null;
}

/** A contact's email, E.164 phone and name: the shape leadIntake.contactKeys returns. */
function contactKeys(c) {
  const email = String((c && c.email) || '').toLowerCase();
  const name = (c && (c.contactName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' '))) || '';
  return { name, email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '', phone: (c && c.phone) || null, phone_raw: (c && c.phone) || '' };
}

async function findOrCreateBusiness({ company, website } = {}) {
  if (!company) return null;
  // No search endpoint for businesses: page the list (about 320 today).
  let hit = null;
  for (let skip = 0; skip < 2000 && !hit; skip += 100) {
    const d = await api('GET', `/businesses/?${qs({ locationId: LOCATION(), limit: 100, skip })}`);
    const list = d.businesses || [];
    hit = list.find(b => norm(b.name) === norm(company)) || null;
    if (list.length < 100) break;
  }
  if (hit) return { id: hit.id, created: false };
  const body = { locationId: LOCATION(), name: company };
  if (website) body.website = /^https?:\/\//.test(website) ? website : `https://${website}`;
  const made = await api('POST', '/businesses/', body).catch(() => api('POST', '/businesses/', { locationId: LOCATION(), name: company }));
  const b = made.business || made.buiseness || {}; // GHL's own typo in the response
  return b.id ? { id: b.id, created: true } : null;
}

async function addNote(contactId, body, userId) {
  const d = await api('POST', `/contacts/${contactId}/notes`, { body: String(body).slice(0, 60000), ...(userId ? { userId } : {}) });
  return (d.note && d.note.id) || null;
}

async function notes(contactId) {
  return (await api('GET', `/contacts/${contactId}/notes`)).notes || [];
}

// ── Opportunities ────────────────────────────────────────────────────────────

async function searchOpps(params = {}) {
  const d = await api('GET', `/opportunities/search?${qs({ location_id: LOCATION(), limit: 100, ...params })}`);
  return d.opportunities || [];
}

async function getOpp(id) {
  return (await api('GET', `/opportunities/${id}`)).opportunity || null;
}

/** A contact's opportunities, the configured pipeline's first, open before closed. */
async function oppsFor(contactId) {
  const p = await pipeline();
  const list = await searchOpps({ contact_id: contactId });
  const rank = o => (o.pipelineId === p.id ? 0 : 2) + (o.status === 'open' ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b));
}

/**
 * An opportunity in the configured pipeline for a contact. One per contact per
 * pipeline, so when it's already there the existing one is returned
 * ({ existing: true }) and nothing is written. Returns { id, existing, stage }.
 */
async function newPipelineOpp({ name, contactId, role = 'new', source, assignedTo, value }) {
  const p = await pipeline();
  const stage = (await stageFor(role)) || p.stages[0];
  const body = { locationId: LOCATION(), pipelineId: p.id, pipelineStageId: stage.id, name, status: 'open', contactId };
  if (source) body.source = source;
  if (assignedTo) body.assignedTo = assignedTo;
  if (value) body.monetaryValue = Number(value);
  try {
    const made = await api('POST', '/opportunities/', body);
    return { id: made.opportunity.id, existing: false, stage: stage.name };
  } catch (e) {
    const existingId = e.data && e.data.meta && e.data.meta.existingId;
    if (!existingId) throw e;
    const o = await getOpp(existingId).catch(() => null);
    const s = o && p.stages.find(x => x.id === o.pipelineStageId);
    return { id: existingId, existing: true, stage: s ? s.name : null, status: o ? o.status : null };
  }
}

/**
 * Move an opportunity forward to a role's stage. Never backward, never out of
 * a closed status. Returns a line for the timeline, or null when `quiet` and
 * nothing changed.
 */
async function moveStage(oppId, role, { quiet = false } = {}) {
  const p = await pipeline();
  const target = await stageFor(role);
  if (!target) return quiet ? null : `GHL stage not changed: the pipeline has no "${stageNames()[role] || role}" stage`;
  const o = await getOpp(oppId);
  if (!o) return quiet ? null : 'GHL stage not changed: opportunity not found';
  if (o.pipelineId !== p.id) return quiet ? null : 'GHL stage not changed: opportunity is in another pipeline';
  if (o.status !== 'open') return quiet ? null : `GHL stage not changed: opportunity is ${o.status}`;
  const cur = p.stages.find(s => s.id === o.pipelineStageId);
  if (cur && cur.position >= target.position) return quiet ? null : `GHL stage left at ${cur.name} (already there or past it)`;
  await api('PUT', `/opportunities/${oppId}`, { pipelineId: p.id, pipelineStageId: target.id });
  return `GHL stage set to ${target.name}`;
}

let _reasons = { at: 0, list: null };
async function lostReasons() {
  if (_reasons.list && Date.now() - _reasons.at < 10 * 6e4) return _reasons.list;
  const d = await api('GET', `/opportunities/lost-reason?${qs({ locationId: LOCATION() })}`).catch(() => ({}));
  _reasons = { at: Date.now(), list: (d.lostReasons || []).map(r => ({ id: r.id || r._id, name: r.name || r.reason || '' })) };
  return _reasons.list;
}

/**
 * Close an opportunity as won or lost. A lost close moves the card to the
 * role's column first (lost or unqualified) and sets the lost reason when GHL
 * has one by that name; the reason always goes in the returned line.
 * An opportunity someone already closed is left as is.
 */
async function closeOpp(oppId, status, { reason = '', role = null } = {}) {
  const o = await getOpp(oppId);
  if (!o) throw new Error('opportunity not found');
  if (o.status !== 'open') return { changed: false, status: o.status };
  const p = await pipeline();
  const column = o.pipelineId === p.id ? await stageFor(role || (status === 'won' ? 'won' : 'lost')) : null;
  if (column && column.id !== o.pipelineStageId) {
    await api('PUT', `/opportunities/${oppId}`, { pipelineId: p.id, pipelineStageId: column.id }).catch(e => console.warn('[ghl] close column move failed:', e.message));
  }
  const body = { status };
  if (status === 'lost' && reason) {
    const r = (await lostReasons()).find(x => norm(x.name) === norm(reason));
    if (r) body.lostReasonId = r.id;
  }
  await api('PUT', `/opportunities/${oppId}/status`, body);
  return { changed: true, status, reason_set: !!body.lostReasonId };
}

// ── Links ────────────────────────────────────────────────────────────────────

const APP = () => process.env.GHL_APP_URL || 'https://app.gohighlevel.com';
const contactUrl = contactId => `${APP()}/v2/location/${LOCATION()}/contacts/detail/${contactId}`;
const oppUrl = oppId => `${APP()}/v2/location/${LOCATION()}/opportunities/list?opportunityId=${oppId}`;

// ── The call scorecard's "Send to CRM" ───────────────────────────────────────

const SOURCE_FOR = [[/referral/i, 'Referral'], [/event|vault/i, 'Conference'], [/google ads|website|seo/i, 'Web Signup'], [/cold|linkedin/i, 'Cold Call']];

/**
 * Same contract as nutshell.pushScorecard. `leadId` is the GHL opportunity id.
 * A re-send (leadId and contactId already known) only adds a note.
 */
async function pushScorecard(p, progress = () => {}) {
  // Ids a scorecard saved while Nutshell was the CRM are numbers: not ours, so start clean.
  const mine = v => (v && !/^\d+$/.test(String(v)) ? String(v) : null);
  const out = { crm: 'ghl', crmName: 'Go High Level', leadId: mine(p.leadId), contactId: mine(p.contactId), accountId: mine(p.accountId), created: [] };
  const owner = USERS[String(p.repEmail || '').toLowerCase()] || null;

  if (!out.leadId || !out.contactId) {
    progress('Finding the company');
    const biz = await findOrCreateBusiness(p).catch(e => { console.warn('[ghl] business:', e.message); return null; });
    if (biz) { out.accountId = biz.id; if (biz.created) out.created.push('company'); }

    progress('Finding the contact');
    // A company with no person still needs a contact to hang the opportunity on.
    const contact = await findOrCreateContact({ name: p.name || (!p.email ? p.company : ''), email: p.email, title: p.title, company: p.company, businessId: out.accountId, assignedTo: owner });
    if (!contact) throw new Error('Need a name, email, or company to make the contact');
    out.contactId = contact.id;
    if (contact.created) out.created.push('contact');

    progress('Creating the opportunity');
    const src = (SOURCE_FOR.find(([re]) => re.test(p.source || '')) || [])[1] || p.source || undefined;
    const opp = await newPipelineOpp({
      name: p.leadTitle || `${p.company || p.name || 'New prospect'}: ${p.packageLine || 'discovery'}`,
      contactId: out.contactId, role: 'new', source: src, assignedTo: owner,
    });
    out.leadId = opp.id;
    if (!opp.existing) out.created.push('lead');
  }

  progress('Adding the call notes');
  await addNote(out.contactId, p.note, owner);
  out.url = contactUrl(out.contactId);
  return out;
}

// ── Reads for the morning feed and the intake ────────────────────────────────

/** Open tasks due by `endOfDay` for one user. */
async function tasksDue(userId, endOfDay) {
  const d = await api('POST', `/locations/${LOCATION()}/tasks/search`, { completed: false, assignedTo: [userId], limit: 100 });
  return (d.tasks || [])
    .filter(t => !t.completed && t.dueDate && new Date(t.dueDate) <= endOfDay)
    .map(t => ({ id: t._id || t.id, title: t.title || '', due: String(t.dueDate).slice(0, 10), contactId: t.contactId || null, lead: (t.contactDetails && [t.contactDetails.firstName, t.contactDetails.lastName].filter(Boolean).join(' ')) || null }));
}

/** Opportunities made after `since`, newest first, with the owner on each. Imported ones are left out. */
async function oppsSince(since, { assignedTo, pipelineIds, limit = 50 } = {}) {
  const list = await searchOpps({ order: 'added_desc', limit: Math.min(limit, 100), ...(assignedTo ? { assigned_to: assignedTo } : {}) });
  const t = new Date(since).getTime();
  return list.filter(o => new Date(o.createdAt).getTime() > t)
    .filter(o => !pipelineIds || pipelineIds.includes(o.pipelineId))
    .filter(o => !/nutshell import/i.test(o.source || ''));
}

/** The pipelines the intake watches, as ids. */
async function intakePipelineIds() {
  const names = (process.env.GHL_INTAKE_PIPELINES || pipelineName()).split(',').map(norm).filter(Boolean);
  return (await pipelines()).filter(p => names.includes(norm(p.name))).map(p => p.id);
}

/**
 * Whose lead a person is: the owner of their open opportunities, else the
 * contact's owner. Returns { status: 'mine' | 'theirs' | 'unassigned' | 'unknown', lead_id, contact_id, owner }.
 */
async function ownerOf({ email, phone } = {}) {
  const c = await findContact({ email, phone });
  if (!c) return { status: 'unknown', why: 'no GHL contact found' };
  const open = (await searchOpps({ contact_id: c.id })).filter(o => o.status === 'open');
  const ids = [...new Set(open.map(o => o.assignedTo).filter(Boolean))];
  const lead = open.find(o => o.assignedTo === ME()) || open[0] || null;
  const owner = ids.includes(ME()) ? ME() : ids[0] || c.assignedTo || null;
  if (!owner) return { status: 'unassigned', lead_id: lead ? lead.id : null, contact_id: c.id, why: 'not assigned yet' };
  return { status: owner === ME() ? 'mine' : 'theirs', lead_id: lead ? lead.id : null, contact_id: c.id, owner: userName(owner) };
}

module.exports = {
  isConfigured, on, api, USERS, ME, userName,
  pipeline, stageFor, stageNames, checkConfig, intakePipelineIds,
  findContact, findOrCreateContact, getContact, contactKeys, findOrCreateBusiness, addNote, notes,
  searchOpps, getOpp, oppsFor, newPipelineOpp, moveStage, closeOpp, lostReasons,
  pushScorecard, tasksDue, oppsSince, ownerOf, contactUrl, oppUrl,
};

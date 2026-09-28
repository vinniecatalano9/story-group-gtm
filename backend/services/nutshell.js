// Nutshell CRM (JSON-RPC API). Replaced CoterieHQ as the sales CRM on 2026-09-28.
//
// Nutshell is slow: lookups take seconds, writes can take close to a minute,
// and its gateway gives up at 60s. So every call gets a long timeout and a
// retry, and every create is preceded by a search — a write that "timed out"
// often landed anyway, and a blind retry would create a duplicate.

const ENDPOINT = 'https://app.nutshell.com/api/v1/json';
const USERNAME = () => process.env.NUTSHELL_USERNAME || 'vincent@storygroup.io';
const API_KEY = () => process.env.NUTSHELL_API_KEY;

// Nutshell user ids (findUsers, 2026-09-28). Keyed by email so the scorecard can
// assign the lead to whoever ran the call.
const USERS = {
  'vincent@storygroup.io': 3,
  'mmoonan@storygroup.io': 4,
  'mckenna@storygroup.io': 4,
  'michelle@storygroup.io': 7,
  'aaron@storygroup.io': 1,
  'annette@storygroup.io': 5,
  'lydia@storygroup.io': 6,
};

// Nutshell lead sources (findSources): 1 Web Signup, 2 Cold Call, 3 Conference, 4 Meeting, 5 Referral.
function sourceId(scorecardSource = '') {
  if (/referral/i.test(scorecardSource)) return 5;
  if (/event|vault/i.test(scorecardSource)) return 3;
  if (/google ads|website|seo/i.test(scorecardSource)) return 1;
  if (/cold|linkedin/i.test(scorecardSource)) return 2;
  return null;
}

const isConfigured = () => !!API_KEY();

async function call(method, params = {}, { attempts = 2, timeoutMs = 90000 } = {}) {
  if (!isConfigured()) throw new Error('NUTSHELL_API_KEY is not set on the server');
  const auth = Buffer.from(`${USERNAME()}:${API_KEY()}`).toString('base64');
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Nutshell ${method} HTTP ${res.status}`);
      const data = JSON.parse(text);
      if (data.error) throw new Error(`Nutshell ${method}: ${data.error.message || JSON.stringify(data.error)}`);
      return data.result;
    } catch (e) {
      lastErr = e;
      console.warn(`[nutshell] ${method} attempt ${i + 1} failed: ${e.message}`);
      if (/401|403|not set/.test(e.message)) break;  // retrying won't fix auth
    }
  }
  throw lastErr;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function findOrCreateAccount({ company, website }) {
  if (!company) return null;
  const hits = await call('searchAccounts', { string: company, limit: 10 });
  const hit = (hits || []).find(a => norm(a.name) === norm(company));
  if (hit) return { id: hit.id, created: false };
  const account = { name: company };
  if (website) account.url = [/^https?:\/\//.test(website) ? website : `https://${website}`];
  const made = await call('newAccount', { account });
  return { id: made.id, created: true };
}

async function findOrCreateContact({ name, email, title, accountId }) {
  if (email) {
    const found = await call('searchByEmail', { emailAddressString: email });
    const hit = found && found.contacts && found.contacts[0];
    if (hit) return { id: hit.id, created: false };
  } else if (name) {
    const hits = await call('searchContacts', { string: name, limit: 10 });
    const hit = (hits || []).find(c => norm(c.name) === norm(name));
    if (hit) return { id: hit.id, created: false };
  }
  if (!name && !email) return null;
  const contact = { name: name || email };
  if (email) contact.email = { '--primary': email };
  if (accountId) contact.accounts = [{ id: accountId, relationship: title || '' }];
  const made = await call('newContact', { contact });
  return { id: made.id, created: true };
}

/**
 * Push one scorecard to Nutshell. If the scorecard already made a lead, only a
 * new note is added to it, so re-sending after Call 2 doesn't duplicate anything.
 * `progress(step)` reports where it is, for the scorecard's status line.
 */
async function pushScorecard(p, progress = () => {}) {
  const out = { leadId: p.leadId || null, contactId: p.contactId || null, accountId: p.accountId || null, created: [] };

  if (!out.leadId) {
    progress('Finding the company');
    const account = await findOrCreateAccount(p);
    if (account) { out.accountId = account.id; if (account.created) out.created.push('company'); }

    progress('Finding the contact');
    const contact = await findOrCreateContact({ ...p, accountId: out.accountId });
    if (contact) { out.contactId = contact.id; if (contact.created) out.created.push('contact'); }

    progress('Creating the lead');
    const lead = { description: p.leadTitle || `${p.company || p.name || 'New prospect'} — ${p.packageLine || 'discovery'}` };
    if (out.accountId) lead.primaryAccount = { id: out.accountId };
    if (out.contactId) lead.contacts = [{ id: out.contactId }];
    const owner = USERS[String(p.repEmail || '').toLowerCase()];
    if (owner) lead.assignee = { entityType: 'Users', id: owner };
    const src = sourceId(p.source);
    if (src) lead.sources = [{ id: src }];
    const made = await call('newLead', { lead });
    out.leadId = made.id;
    out.created.push('lead');
  }

  progress('Adding the call notes');
  await call('newNote', { entity: { entityType: 'Leads', id: out.leadId }, note: p.note });

  return out;
}

module.exports = { isConfigured, call, pushScorecard, USERS };

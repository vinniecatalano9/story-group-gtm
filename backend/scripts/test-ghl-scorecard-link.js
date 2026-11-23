// Checks the scorecard's pasted GHL contact link (11/23): notes land on the pasted
// contact, a bad link falls back to matching by email, no link matches by email.
// No network: global fetch is a fake GHL. Run: node scripts/test-ghl-scorecard-link.js
process.env.GHL_API_KEY = 'test';
process.env.GHL_LOCATION_ID = 'LOC';
const calls = [];
const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
global.fetch = async (url, opts = {}) => {
  const path = url.replace('https://services.leadconnectorhq.com', '').split('?')[0];
  const method = opts.method || 'GET';
  calls.push(`${method} ${path}`);
  if (path === '/opportunities/pipelines') return json(200, { pipelines: [{ id: 'P1', name: 'LMD_Ads', stages: [{ id: 'S1', name: 'Inbound Lead' }] }, { id: 'P2', name: 'Sales', stages: [] }] });
  if (path.startsWith('/opportunities/search')) return json(200, { opportunities: [] });
  if (method === 'POST' && path === '/opportunities/') return json(200, { opportunity: { id: 'OPP1' } });
  if (/business/i.test(path)) return json(400, { message: 'no business in this test' });
  if (path === '/contacts/search/duplicate') return json(200, { contact: { id: 'BYEMAIL' } });
  if (path === '/contacts/search') return json(200, { contacts: [] });
  if (method === 'GET' && path === '/contacts/PASTED123') return json(200, { contact: { id: 'PASTED123' } });
  if (method === 'GET' && path === '/contacts/BADLINK99') return json(404, { message: 'Contact not found' });
  if (method === 'POST' && /^\/contacts\/[^/]+\/notes$/.test(path)) return json(200, { note: { id: 'N1' } });
  if (method === 'POST' && path === '/contacts/') return json(200, { contact: { id: 'NEWCONTACT' } });
  return json(404, { message: `unmocked ${method} ${path}` });
};
const ghl = require('../services/ghl');
let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++; };
const base = { name: 'Test Person', email: 'test@example.com', company: 'Test Co', note: 'call notes', repEmail: 'vincent@storygroup.io' };
const noteOn = () => (calls.find(c => /\/notes$/.test(c)) || '').split('/')[2];

(async () => {
  calls.length = 0;
  let r = await ghl.pushScorecard({ ...base, contactId: 'PASTED123' });
  ok(r.contactId === 'PASTED123' && noteOn() === 'PASTED123', 'pasted link: notes land on the pasted contact');
  ok(!calls.some(c => c.includes('/contacts/search')), 'pasted link: no email lookup');
  ok(r.leadId === 'OPP1', 'pasted link: opportunity made on that contact');

  calls.length = 0;
  r = await ghl.pushScorecard({ ...base, contactId: 'BADLINK99' });
  ok(r.contactId === 'BYEMAIL' && noteOn() === 'BYEMAIL', 'bad link: falls back to matching by email');

  calls.length = 0;
  r = await ghl.pushScorecard({ ...base });
  ok(r.contactId === 'BYEMAIL' && noteOn() === 'BYEMAIL', 'no link: matches by email as before');

  calls.length = 0;
  r = await ghl.pushScorecard({ ...base, contactId: 'PASTED123', leadId: 'OPP9' });
  ok(r.contactId === 'PASTED123' && !calls.some(c => c.startsWith('GET /contacts/PASTED123')) && calls.length === 1, 're-send: only adds the note');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL threw:', e.message); process.exit(1); });

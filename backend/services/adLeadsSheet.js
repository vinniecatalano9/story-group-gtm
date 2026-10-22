// services/adLeadsSheet.js — the shared "AD LEADS LIST_2026" Google Sheet.
//
// Reads the lead rows for the dashboard import, and writes the cadence's
// Outreach Status (J), Last Touch (K) and Next Touch (L) back on the row whose
// Email (C) matches. Auth is the backend's service account
// (GOOGLE_APPLICATION_CREDENTIALS), so the sheet has to be shared with it as
// Editor and the Sheets API enabled on its Google Cloud project. Until then
// every call warns and returns null; nothing crashes.

const { google } = require('googleapis');

const SHEET_ID = () => process.env.AD_LEADS_SHEET_ID || '1qMYNGAEELfc8GLkg5hoLrBXAr2rXx6kLa40WfUxI1ZQ';
const TAB = () => process.env.AD_LEADS_SHEET_TAB || ''; // blank = first tab
const EMAIL_COL = 'C';
const WRITE_COLS = ['J', 'K', 'L']; // Outreach Status, Last Touch, Next Touch
const REP = () => process.env.AD_LEADS_REP || 'Vincent'; // only rows assigned to him

// Cadence state -> the Outreach Status dropdown (Not contacted, In sequence,
// Replied (paused), Hit once, Talked yes, Meeting yes, Not interested). Override with
// AD_LEADS_STATUS_MAP='{"active":"In cadence",...}' if the dropdown changes.
const STATUS = () => ({
  imported: 'Not contacted',
  active: 'In sequence',
  blocked: 'In sequence',
  done: 'In sequence', // finished with no reply; Next Touch says so
  replied: 'Replied (paused)',
  hit_once: 'Hit once',
  talked_yes: 'Talked yes',
  meeting: 'Meeting yes',
  not_interested: 'Not interested',
  opted_out: 'Not interested',
  stopped: 'Not interested',
  ...JSON.parse(process.env.AD_LEADS_STATUS_MAP || '{}'),
});

let _sheets = null;
function sheets() {
  if (!_sheets) _sheets = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) });
  return _sheets;
}

let _tab = null;
async function tabName() {
  if (TAB()) return TAB();
  if (_tab) return _tab;
  const r = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), fields: 'sheets.properties.title' });
  _tab = r.data.sheets[0].properties.title;
  return _tab;
}
const q = name => `'${String(name).replace(/'/g, "''")}'`;

/** Header-keyed rows: [{ row, values: {header: value}, raw: [...] }]. */
async function readRows() {
  const tab = await tabName();
  const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${q(tab)}!A1:Z` });
  const [header = [], ...rows] = r.data.values || [];
  return {
    tab,
    header,
    rows: rows.map((raw, i) => ({
      row: i + 2,
      raw,
      values: Object.fromEntries(header.map((h, j) => [String(h).trim(), (raw[j] || '').trim()])),
    })).filter(x => x.raw.some(v => String(v).trim())),
  };
}

/** Find a column by any of these header words (case-insensitive substring). */
function pick(values, ...names) {
  const keys = Object.keys(values);
  for (const n of names) {
    const k = keys.find(h => h.toLowerCase().includes(n));
    if (k && values[k]) return values[k];
  }
  return '';
}

/** Sheet rows mapped to cadence lead fields. */
async function readLeads() {
  const { rows, header, tab } = await readRows();
  const leads = rows.map(({ row, values, raw }) => {
    const full = pick(values, 'full name', 'name');
    const first = pick(values, 'first') || full.split(/\s+/)[0] || '';
    const last = pick(values, 'last') || full.split(/\s+/).slice(1).join(' ');
    return {
      sheet_row: row,
      email: (raw[2] || pick(values, 'email')).trim().toLowerCase(),
      first_name: first,
      last_name: last,
      phone: pick(values, 'phone', 'mobile', 'cell'),
      role: pick(values, 'role', 'title', 'position', 'describes'),
      frustration: pick(values, 'frustrat', 'challenge', 'struggle'),
      company: pick(values, 'company', 'business', 'organization'),
      source: pick(values, 'source'),
      rep: pick(values, 'assigned', 'rep', 'owner'),
      notes: pick(values, 'notes'),
      sheet_values: values,
    };
  }).filter(l => /@/.test(l.email) && (!l.rep || l.rep.toLowerCase().includes(REP().toLowerCase())));
  return { tab, header, leads };
}

/**
 * Write J/K/L for these leads, matched on column C. Returns rows written, or
 * null when the sheet can't be reached (logged, never thrown).
 * @param updates [{ email, status, last_touch, next_touch }]
 */
async function writeBack(updates) {
  if (!updates.length) return 0;
  try {
    const tab = await tabName();
    const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${q(tab)}!${EMAIL_COL}1:${EMAIL_COL}` });
    const emails = (r.data.values || []).map(v => String(v[0] || '').trim().toLowerCase());
    const map = STATUS();
    const data = [];
    for (const u of updates) {
      const i = emails.indexOf(String(u.email).toLowerCase());
      if (i < 1) continue;
      data.push({
        range: `${q(tab)}!${WRITE_COLS[0]}${i + 1}:${WRITE_COLS[2]}${i + 1}`,
        values: [[map[u.status] || u.status || '', u.last_touch || '', u.next_touch || '']],
      });
    }
    if (!data.length) return 0;
    await sheets().spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID(), requestBody: { valueInputOption: 'USER_ENTERED', data } });
    return data.length;
  } catch (e) {
    console.warn('[adLeadsSheet] write-back failed:', e.message);
    return null;
  }
}

/** Can the backend read the sheet? For the status endpoint. */
async function status() {
  try {
    const { tab, header, rows } = await readRows();
    return { ok: true, tab, header, rows: rows.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { readLeads, writeBack, status, STATUS };

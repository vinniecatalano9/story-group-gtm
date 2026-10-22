// services/adLeadsSheet.js — the shared "AD LEADS LIST_2026" Google Sheet.
//
// Reads the lead rows for the dashboard import, and writes the cadence's
// Outreach Status (J), Last Touch (K), Next Touch (L) and Touches So Far (M)
// back on the row whose Email (C) matches. After a call, one line is appended
// to Notes (I) (appendNote); Notes is never overwritten. Auth is the backend's service account
// (GOOGLE_APPLICATION_CREDENTIALS), so the sheet has to be shared with it as
// Editor and the Sheets API enabled on its Google Cloud project. Until then
// every call warns and returns null; nothing crashes.

const { google } = require('googleapis');

const SHEET_ID = () => process.env.AD_LEADS_SHEET_ID || '1qMYNGAEELfc8GLkg5hoLrBXAr2rXx6kLa40WfUxI1ZQ';
const TAB = () => process.env.AD_LEADS_SHEET_TAB || '2026 ADs list';
const EMAIL_COL = 'C';
const WRITE_COLS = ['J', 'M']; // J Outreach Status, K Last Touch, L Next Touch, M Touches So Far
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
  // Channel failures (Vincent, 10/22); added to the J dropdown by ensureStatusOptions().
  email_bounced: 'Email bounced, texts only',
  email_invalid: 'Email invalid, texts only',
  sms_failed: 'Texts failed, email only',
  dead: 'No working channel',
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
    // 'first name' / 'last name' exactly: plain 'last' would hit "Last Touch".
    const cap = n => (n && n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n);
    const first = cap(pick(values, 'first name') || full.split(/\s+/)[0] || '');
    const last = pick(values, 'last name') || full.split(/\s+/).slice(1).join(' ');
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
 * Write J:M for these leads, matched on column C. Returns rows written, or
 * null when the sheet can't be reached (logged, never thrown).
 * @param updates [{ email, status, last_touch, next_touch, touches }]
 */
async function writeBack(updates) {
  if (!updates.length) return 0;
  try {
    const tab = await tabName();
    const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${q(tab)}!A1:Z` });
    const [header = [], ...rows] = r.data.values || [];
    const repCol = header.findIndex(h => /assigned|rep\b/i.test(String(h)));
    // Only Vincent's rows; never write on a teammate's (McKenna's) row.
    const { toE164 } = require('./ringcentral');
    const mineRow = row => repCol < 0 || String(row[repCol] || '').toLowerCase().includes(REP().toLowerCase());
    const emails = [''].concat(rows.map(row => (mineRow(row) ? String(row[2] || '').trim().toLowerCase() : '')));
    // Texts-only leads (no valid email) are matched on the phone in column B.
    const phones = [''].concat(rows.map(row => (mineRow(row) ? toE164(row[1]) || '' : '')));
    const map = STATUS();
    const data = [];
    for (const u of updates) {
      let i = u.email ? emails.indexOf(String(u.email).toLowerCase()) : -1;
      if (i < 1 && !u.email && u.phone) i = phones.indexOf(u.phone);
      if (i < 1) continue;
      data.push({
        range: `${q(tab)}!${WRITE_COLS[0]}${i + 1}:${WRITE_COLS[1]}${i + 1}`,
        values: [[map[u.status] || u.status || '', u.last_touch || '', u.next_touch || '', u.touches || '']],
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

/**
 * Append one line to Notes (I) on Vincent's row for this lead, matched like
 * writeBack (email in C, else phone in B). Reads the cell first and keeps what
 * the team wrote there; nothing in Notes is ever replaced. Returns true when
 * written, false when there was nothing to do, null when the sheet failed.
 */
async function appendNote({ email, phone, line }) {
  if (!line) return false;
  try {
    const tab = await tabName();
    const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `${q(tab)}!A1:Z` });
    const [header = [], ...rows] = r.data.values || [];
    const repCol = header.findIndex(h => /assigned|rep\b/i.test(String(h)));
    const notesCol = header.findIndex(h => /^notes?$/i.test(String(h).trim()));
    if (notesCol < 0 || notesCol > 25) return false;
    const { toE164 } = require('./ringcentral');
    const mine = row => repCol < 0 || String(row[repCol] || '').toLowerCase().includes(REP().toLowerCase());
    let i = email ? rows.findIndex(row => mine(row) && String(row[2] || '').trim().toLowerCase() === String(email).toLowerCase()) : -1;
    if (i < 0 && !email && phone) i = rows.findIndex(row => mine(row) && toE164(row[1]) === phone);
    if (i < 0) return false;
    const cur = String(rows[i][notesCol] || '').trimEnd();
    if (cur.includes(line)) return false;
    await sheets().spreadsheets.values.update({
      spreadsheetId: SHEET_ID(), range: `${q(tab)}!${String.fromCharCode(65 + notesCol)}${i + 2}`, valueInputOption: 'RAW',
      requestBody: { values: [[cur ? `${cur}\n${line}` : line]] },
    });
    return true;
  } catch (e) {
    console.warn('[adLeadsSheet] Notes append failed:', e.message);
    return null;
  }
}

/**
 * Add one lead row (A:H only: Notes in I and the cadence's J:M are left alone)
 * below the last row, with the same dropdowns as Vincent's rows. Returns the row number.
 * @param cells [Full Name, Phone, Email, role, frustration, Channel, Lead Status, Assigned Rep]
 */
async function appendLead(cells) {
  const tab = await tabName();
  const r = await sheets().spreadsheets.values.append({
    spreadsheetId: SHEET_ID(), range: `${q(tab)}!A1:H1`, valueInputOption: 'USER_ENTERED', insertDataOption: 'OVERWRITE',
    requestBody: { values: [cells.slice(0, 8)] },
  });
  const row = Number(((r.data.updates && r.data.updates.updatedRange) || '').match(/!A(\d+)/)?.[1]);
  if (!row) throw new Error(`append gave no row (${r.data.updates && r.data.updates.updatedRange})`);
  try {
    const { rows, header } = await readRows();
    const repCol = header.findIndex(h => /assigned|rep\b/i.test(String(h)));
    const model = rows.find(x => x.row !== row && String(x.raw[repCol] || '').toLowerCase().includes(REP().toLowerCase()));
    if (model) {
      const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), fields: 'sheets.properties' });
      const sheetId = meta.data.sheets.find(s => s.properties.title === tab).properties.sheetId;
      const span = (n) => ({ sheetId, startRowIndex: n - 1, endRowIndex: n, startColumnIndex: 0, endColumnIndex: 13 });
      await sheets().spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID(), requestBody: { requests: [{ copyPaste: { source: span(model.row), destination: span(row), pasteType: 'PASTE_DATA_VALIDATION' } }] } });
    }
  } catch (e) {
    console.warn('[adLeadsSheet] dropdown copy for new row failed:', e.message);
  }
  return row;
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

/**
 * Make sure the J dropdown (Vincent's rows) offers every status we write;
 * the rule is strict, so a missing option would make the whole write fail.
 */
async function ensureStatusOptions() {
  const tab = await tabName();
  const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), ranges: [`${q(tab)}!J2`], fields: 'sheets(properties(sheetId),data(rowData(values(dataValidation))))' });
  const sh = meta.data.sheets[0];
  const dv = (((sh.data[0].rowData || [])[0] || {}).values || [{}])[0].dataValidation;
  if (!dv || !dv.condition || dv.condition.type !== 'ONE_OF_LIST') return { changed: false, reason: 'no list dropdown on J2' };
  const have = dv.condition.values.map(v => v.userEnteredValue);
  const want = [...new Set(Object.values(STATUS()))].filter(v => !have.includes(v));
  if (!want.length) return { changed: false };
  const { rows } = await readRows();
  const repCol = (await readRows()).header.findIndex(h => /assigned|rep\b/i.test(String(h)));
  const mine = rows.filter(r => repCol < 0 || String(r.raw[repCol] || '').toLowerCase().includes(REP().toLowerCase())).map(r => r.row);
  const requests = mine.map(row => ({
    setDataValidation: {
      range: { sheetId: sh.properties.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 9, endColumnIndex: 10 },
      rule: { ...dv, condition: { type: 'ONE_OF_LIST', values: [...have, ...want].map(v => ({ userEnteredValue: v })) } },
    },
  }));
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID(), requestBody: { requests } });
  return { changed: true, added: want, rows: mine };
}

module.exports = { appendNote, readLeads, readRows, appendLead, writeBack, status, STATUS, ensureStatusOptions };

import { useState, useRef, useCallback, useEffect } from 'react';

// ── Company Name Cleaner (runs in browser) ──────────────────────────────────

const SUFFIXES = [
  'limited\\s+liability\\s+company',
  'limited\\s+liability\\s+partnership',
  'professional\\s+limited\\s+liability\\s+company',
  'professional\\s+corporation',
  'professional\\s+association',
  'incorporated', 'corporation',
  'limited\\s+partnership', 'limited',
  'general\\s+partnership', 'company',
  'p\\.?\\s*l\\.?\\s*l\\.?\\s*c\\.?', 'l\\.?\\s*l\\.?\\s*c\\.?', 'l\\.?\\s*l\\.?\\s*p\\.?',
  'l\\.?\\s*p\\.?\\s*a\\.?',  // L.P.A. / L. P. A.
  'l\\.?\\s*p\\.?',
  'p\\.?\\s*c\\.?', 'p\\.?\\s*l\\.?\\s*c\\.?',
  'p\\.?\\s*a\\.?',  // P.A. / P. A. / P. A
  'a\\.?\\s*p\\.?\\s*c\\.?',  // APC / A.P.C.
  's\\.?\\s*c\\.?',  // S.C. / S. C.
  'inc\\.?', 'corp\\.?', 'co\\.?', 'ltd\\.?', 'g\\.?\\s*p\\.?',
  's\\.?\\s*a\\.?', 'n\\.?\\s*a\\.?', 's\\.?\\s*r\\.?\\s*l\\.?',
  'gmbh', 'ag', 'pty', 'pvt', 'plc', 'llp', 'llc', 'llo', 'lp',
  'p\\.?\\s*s\\.?\\s*c\\.?',  // PSC
  'p\\.?\\s*l\\.?\\s*l\\.?\\s*p\\.?',  // PLLP
  'a\\.?\\s*p\\.?\\s*l\\.?\\s*c\\.?',  // APLC
  'l\\.?\\s*c\\.?',   // LC
  'l\\.?\\s*p\\.?\\s*a\\.?',  // LPA
  'p\\.?\\s*s\\.?',   // PS / P.S.
  'p\\.?\\s*l\\.?',   // PL / P.L.
  'apc', 'pa',
];

const SUFFIX_RE = new RegExp(
  '[\\s,.\\/|\\-]*\\b(?:' + SUFFIXES.join('|') + ')\\s*\\.?\\s*$', 'i'
);
const PAREN_RE = new RegExp(
  '\\s*\\((?:' + SUFFIXES.join('|') + ')\\)\\s*\\.?\\s*', 'i'
);

// Fix mojibake / encoding garbage
// Handles double and triple UTF-8 encoding corruption from Apollo/CSV exports
function fixEncoding(str) {
  let s = str;
  // Strip registered/trademark symbols and their mojibake
  s = s.replace(/[\xAE\xA9\u2122]/g, '');                           // clean ®©™
  s = s.replace(/[\xC3\xC2][\x82\x83]*[\xC2\xC3]*[\xAE\xA9]/g, ''); // mojibake ®©
  s = s.replace(/\xC3\x83\xC2\xC2\xAE/g, '');
  // Remove parenthetical content like "(formerly ...)"
  s = s.replace(/\s*\(formerly\s+[^)]*\)/gi, '');
  // Try to decode triple-encoded UTF-8 sequences (ÃƒÂƒÃ‚Â pattern)
  // These are common in Apollo exports
  const tripleEnc = {
    '\xC3\x83\xC3\x82\xC2\xA9': 'e',  // é triple
    '\xC3\x83\xC3\x82\xC2\xAB': 'e',  // ë triple
    '\xC3\x83\xC3\x82\xC2\xB1': 'n',  // ñ triple
    '\xC3\x83\xC3\x82\xC2\xA8': 'e',  // è triple
    '\xC3\x83\xC3\x82\xC2\xAE': '',   // ® triple
    '\xC3\x83\xC2\x82\xC3\x82\xC2\xAE': '', // ® quad
  };
  for (const [pattern, replacement] of Object.entries(tripleEnc)) {
    s = s.split(pattern).join(replacement);
  }
  // Simple single mojibake replacements
  s = s.replace(/Ã©/g, 'e').replace(/Ã¨/g, 'e').replace(/Ã«/g, 'e');
  s = s.replace(/Ã¯/g, 'i').replace(/Ã®/g, 'i');
  s = s.replace(/Ã´/g, 'o').replace(/Ã¶/g, 'o');
  s = s.replace(/Ã¼/g, 'u').replace(/Ã¹/g, 'u').replace(/Ã»/g, 'u');
  s = s.replace(/Ã /g, 'a').replace(/Ã¢/g, 'a').replace(/Ã¤/g, 'a');
  s = s.replace(/Ã§/g, 'c').replace(/Ã±/g, 'n');
  // Nuclear option: strip any remaining Ã/Â clusters and non-printable chars
  s = s.replace(/[\xC3\xC2][\x80-\xBF]?/g, '');   // raw byte sequences
  s = s.replace(/[ÃÂ]+/g, '');                      // visible Ã/Â
  s = s.replace(/[^\x20-\x7E]/g, '');               // keep only printable ASCII
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

// Title case: "VOGL MEREDITH" → "Vogl Meredith"
// Keeps short words lowercase, preserves & and common abbreviations
const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'in', 'at', 'by', 'to', 'on', 'or']);
const KEEP_UPPER = new Set(['LLP', 'PC', 'PA', 'SC', 'APC', 'PLC', 'PLLC', 'II', 'III', 'IV']);

function smartTitleCase(str) {
  // Only convert if mostly uppercase (>60% caps)
  const letters = str.replace(/[^a-zA-Z]/g, '');
  const upperCount = (str.match(/[A-Z]/g) || []).length;
  if (letters.length < 3 || upperCount / letters.length < 0.6) return str;

  return str.split(/(\s+|&)/).map((word, i) => {
    if (word.trim() === '&' || word.trim() === '') return word;
    const upper = word.toUpperCase();
    if (KEEP_UPPER.has(upper)) return upper;
    const lower = word.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

// Descriptor words that follow dashes/suffixes — if we see "Suffix + these", strip suffix AND everything after
const DESCRIPTOR_WORDS = /^(?:a\s+|the\s+|an\s+)?(?:personal|attorney|lawyer|legal|law\s+firm|law\s+office|law\s+offices|accident|criminal|family|divorce|immigration|bankruptcy|estate|tax|real\s+estate|business|corporate|employment|civil|trial|appellate|medical|patent|intellectual|insurance|securities|environmental|maritime|labor|workers|wrongful|sexual|discrimination|harassment|defense|prosecution|litigation|counsel|consulting|advisor|practice|specialist|certified|board|experienced|trusted|top|best|premier|leading|award|injury|division|global|international|social\s+security|led\s+by|electronic|hurt|call|class\s+action|healthcare|bridging|colling|america|municipal|bail|reference|western|administrators|network)\b/i;

// Common trailing descriptors after entity suffixes: "LLC Attorneys at Law", "P.A. Injury Lawyers"
const POST_SUFFIX_JUNK = /\s+(?:attorneys?\s+at\s+law|attorneys?|lawyers?|law\s+firm|law\s+offices?|injury\s+lawyers?|family\s+law(?:\s+firm)?|healthcare\s+law|class\s+action\s+administrators?|of\s+western\s+.+)$/i;

function cleanCompanyName(name) {
  if (!name || !name.trim()) return '';
  let c = name.trim();
  // Fix encoding garbage
  c = fixEncoding(c);
  // Strip everything after a pipe: "Foo | blah" → "Foo"
  c = c.replace(/\s*\|.*$/, '').trim();
  // Strip colon descriptions: "Foo: Immigration, Criminal..." → "Foo"
  c = c.replace(/:\s+[A-Z][a-z].*$/, '').trim();
  // Strip dash+descriptor: "Foo - Personal Injury..." → "Foo"
  // But KEEP dashes that are part of actual names like "Morris - Sockle" or "Disability Rights Center - NH"
  // Only strip if what follows the dash looks like a descriptor (3+ words or known descriptor pattern)
  c = c.replace(/\s+[-–—]\s+(.+)$/i, (match, after) => {
    // Keep short suffixes like "- NH" (state/location abbreviations, 1-2 short words)
    const words = after.trim().split(/\s+/);
    if (words.length <= 2 && words.every(w => w.length <= 4)) return match; // keep "- NH", "- DC"
    // Strip if it matches known descriptor patterns
    if (DESCRIPTOR_WORDS.test(after.trim())) return '';
    // Strip if it's 4+ words (likely a tagline/description)
    if (words.length >= 4) return '';
    // Keep everything else (actual name parts like "Morris - Sockle")
    return match;
  }).trim();
  // Strip junk after Inc./Corp./LLC mid-name: "TASA Group, Inc., A Futuris..." → "TASA Group"
  c = c.replace(/,?\s+Inc\.?,?\s+.+$/i, '').trim();
  c = c.replace(/,?\s+Corp\.?,?\s+.+$/i, '').trim();
  c = c.replace(/,?\s+LLC,?\s+.+$/i, '').trim();
  // Strip parenthetical content: "(PILI)", "(MCLENew England)", "(formerly ...)"
  c = c.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Strip parenthetical suffixes (legal entity types in parens)
  c = c.replace(PAREN_RE, ' ').trim();
  // Strip post-suffix descriptors BEFORE suffix removal: "LLC Attorneys at Law" → "LLC" → ""
  c = c.replace(POST_SUFFIX_JUNK, '').trim();
  // Strip trailing legal suffixes (run multiple passes for stacked suffixes)
  for (let i = 0; i < 4; i++) {
    const prev = c;
    c = c.replace(SUFFIX_RE, '');
    if (c === prev) break;
  }
  // Clean trailing junk
  c = c.replace(/[\s,.\-|/]+$/, '').replace(/\s{2,}/g, ' ').trim();
  // Title case ALL CAPS names
  c = smartTitleCase(c);
  return c;
}

// ── CSV Parser (browser) ────────────────────────────────────────────────────

function parseCSVText(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Simple CSV parse handling quoted fields
  function parseLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else field += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { fields.push(field.trim()); field = ''; }
        else field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function detectColumn(headers, candidates) {
  for (const h of headers) {
    if (candidates.includes(h.toLowerCase().trim())) return h;
  }
  for (const h of headers) {
    for (const c of candidates) {
      if (h.toLowerCase().includes(c)) return h;
    }
  }
  return null;
}

// ── Clearout API (direct from browser) ──────────────────────────────────────

// ── Component ───────────────────────────────────────────────────────────────

// ── Master List (IndexedDB — no size limit) ─────────────────────────────────

const DB_NAME = 'gtm_master_leads';
const STORE_NAME = 'leads';
const META_STORE = 'meta';
const RUNS_STORE = 'clean_runs';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: '_id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(RUNS_STORE)) {
        db.createObjectStore(RUNS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveCleanRun(id, rows) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RUNS_STORE, 'readwrite');
    tx.objectStore(RUNS_STORE).put({ id, rows, savedAt: new Date().toISOString() });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getCleanRun(id) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(RUNS_STORE, 'readonly');
    const req = tx.objectStore(RUNS_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function getMasterCount() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  } catch { return 0; }
}

async function getMasterHeaders() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const req = tx.objectStore(META_STORE).get('headers');
      req.onsuccess = () => resolve(req.result?.value || []);
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}

async function getExistingEmails(db, emailCol) {
  if (!emailCol) return new Set();
  return new Promise((resolve) => {
    const seen = new Set();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const email = (cursor.value[emailCol] || '').toLowerCase();
        if (email) seen.add(email);
        cursor.continue();
      } else {
        resolve(seen);
      }
    };
    req.onerror = () => resolve(seen);
  });
}

async function appendToMaster(rows) {
  const db = await openDB();
  const existingHeaders = await getMasterHeaders();
  const newHeaders = rows.length ? Object.keys(rows[0]) : [];
  const allHeaders = [...new Set([...existingHeaders, ...newHeaders, '_cleaned_at'])];

  // Detect email column from the ROW keys (not allHeaders which includes meta fields)
  const rowKeys = rows.length ? Object.keys(rows[0]) : [];
  const emailCol = detectColumn(rowKeys, ['email', 'email_address', 'emailaddress', 'e-mail', 'mail']);

  // Get ALL existing emails first (must complete before we start writing)
  const seen = await getExistingEmails(db, emailCol);

  // Also dedup within the incoming batch
  const batchSeen = new Set();

  let added = 0;
  const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  for (const row of rows) {
    const email = emailCol ? (row[emailCol] || '').toLowerCase().trim() : '';
    if (email) {
      if (seen.has(email) || batchSeen.has(email)) continue;
      batchSeen.add(email);
      seen.add(email);
    }
    row._cleaned_at = new Date().toISOString().split('T')[0];
    store.add({ ...row });
    added++;
  }

  // Save headers
  tx.objectStore(META_STORE).put({ key: 'headers', value: allHeaders });

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  const total = await getMasterCount();
  return { total, added };
}

async function getAllMasterRows() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function clearMasterDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Clean up old localStorage data (was hitting quota limits)
function cleanupOldStorage() {
  try {
    localStorage.removeItem('gtm_master_lead_list');
    localStorage.removeItem('gtm_master_lead_headers');
  } catch {}
}

// ── Clean History Log (localStorage — small metadata only) ──────────────────

function getCleanHistory() {
  try {
    return JSON.parse(localStorage.getItem('clean_history') || '[]');
  } catch { return []; }
}

async function addCleanHistoryEntry(entry, rows) {
  try {
    const id = Date.now().toString(36);
    const history = getCleanHistory();
    history.unshift({
      ...entry,
      timestamp: new Date().toISOString(),
      id,
      hasRows: !!(rows && rows.length),
    });
    // Keep last 20 entries
    localStorage.setItem('clean_history', JSON.stringify(history.slice(0, 20)));
    // Save rows to IndexedDB
    if (rows && rows.length) {
      await saveCleanRun(id, rows);
    }
    return id;
  } catch { return null; }
}

export default function LeadCleaner({ api }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('names');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [masterCount, setMasterCount] = useState(0);
  const [history, setHistory] = useState([]);
  const [showMaster, setShowMaster] = useState(false);
  const [masterRows, setMasterRows] = useState(null);
  const [masterHeaders, setMasterHeaders] = useState([]);
  const fileRef = useRef();
  const pollRef = useRef(null);

  // Load master count on mount + clean old localStorage + resume any active verification
  useEffect(() => {
    cleanupOldStorage();
    getMasterCount().then(setMasterCount).catch(() => {});
    setHistory(getCleanHistory());
    // Resume polling if there's an active Clearout list
    const saved = localStorage.getItem('clearout_active_list');
    if (saved) {
      try {
        const { listId, base } = JSON.parse(saved);
        if (listId) {
          setMode('full');
          setStatus('verifying');
          resumePoll(listId, base || '');
        }
      } catch {}
    }
  }, []);

  // Poll Clearout status and download when done
  const startPoll = (listId, base) => {
    localStorage.setItem('clearout_active_list', JSON.stringify({ listId, base }));
    resumePoll(listId, base);
  };

  const resumePoll = (listId, base) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${base}/api/cleaner/status/${listId}`);
        const data = await resp.json();
        if (!data.success) { clearInterval(pollRef.current); setError('Status check failed'); setStatus('error'); localStorage.removeItem('clearout_active_list'); return; }

        const pct = data.percentage || 0;
        setProgress(pct);

        const state = data.status || '';
        if (['completed', 'done', 'finished'].includes(state)) {
          clearInterval(pollRef.current);
          setStatus('downloading');
          try {
            // Download valid email list from Clearout via backend
            const dlResp = await fetch(`${base}/api/cleaner/download/${listId}`);
            const dlData = await dlResp.json();
            if (!dlData.success) { setError(dlData.error || 'Download failed'); setStatus('error'); localStorage.removeItem('clearout_active_list'); return; }

            // Join valid emails back to our cleaned data
            const validEmails = new Set(
              (dlData.rows || []).map(r => (r['Email Address'] || r.email || r.Email || Object.values(r)[0] || '').toLowerCase()).filter(Boolean)
            );

            let finalRows, totalBefore, cleaned;
            const saved = parsedDataRef.current;
            if (saved && saved.rows?.length) {
              // We have the original parsed+cleaned data — filter to valid emails
              totalBefore = saved.rows.length;
              cleaned = saved.cleaned || 0;
              finalRows = saved.rows.filter(r => {
                const email = (r[saved.emailCol] || '').toLowerCase();
                return email && validEmails.has(email);
              });
            } else {
              // Fallback: page was refreshed, we lost the parsed data — use Clearout's rows directly
              totalBefore = dlData.total_before_filter || dlData.total;
              cleaned = dlData.cleaned || 0;
              finalRows = dlData.rows || [];
            }

            let masterAdded = 0;
            try {
              const master = await appendToMaster(finalRows);
              setMasterCount(master.total);
              masterAdded = master.added;
            } catch (err) { console.warn('Master list save failed:', err); }

            setResult({ total: finalRows.length, cleaned, company_column: saved?.companyCol || dlData.company_column, rows: finalRows, masterAdded });
            await addCleanHistoryEntry({ mode: 'verify', fileName: file?.name, total: finalRows.length, valid: finalRows.length, cleaned, masterAdded, totalBeforeFilter: totalBefore }, finalRows);
            setHistory(getCleanHistory());
            setStatus('done');
          } catch (e) { setError(e.message); setStatus('error'); }
          localStorage.removeItem('clearout_active_list');
        } else if (['failed', 'error'].includes(state)) {
          clearInterval(pollRef.current);
          setError('Verification failed');
          setStatus('error');
          localStorage.removeItem('clearout_active_list');
        }
      } catch (e) { /* keep polling on network blips */ }
    }, 10000);
  };

  const reset = () => {
    setFile(null);
    setStatus('idle');
    setProgress(0);
    setResult(null);
    setError('');
    if (pollRef.current) clearInterval(pollRef.current);
    if (fileRef.current) fileRef.current.value = '';
    localStorage.removeItem('clearout_active_list');
  };

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setError(''); setResult(null); setStatus('idle'); }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && (f.name.endsWith('.csv') || f.name.endsWith('.xlsx'))) {
      setFile(f); setError(''); setResult(null); setStatus('idle');
    }
  }, []);

  // Read file as text
  const readFileText = (f) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(f);
  });

  // ── Mode 1: Clean company names only (all client-side) ──────────────────

  const cleanNamesOnly = async () => {
    if (!file) return;
    setStatus('uploading');
    setError('');
    try {
      const text = await readFileText(file);
      const { headers, rows } = parseCSVText(text);
      if (!rows.length) throw new Error('Empty CSV');

      const companyCol = detectColumn(headers, ['company', 'company_name', 'companyname', 'organization', 'org']);
      let cleaned = 0;

      if (companyCol) {
        for (const row of rows) {
          const original = row[companyCol] || '';
          const clean = cleanCompanyName(original);
          if (clean !== original) cleaned++;
          row[`${companyCol}_original`] = original;
          row[companyCol] = clean;
        }
      }

      // Save to master list
      let masterAdded = 0;
      try {
        const master = await appendToMaster(rows);
        setMasterCount(master.total);
        masterAdded = master.added;
      } catch (err) {
        console.warn('Master list save failed:', err);
      }

      setResult({ total: rows.length, cleaned, company_column: companyCol, rows, masterAdded });
      await addCleanHistoryEntry({ mode: 'names', fileName: file?.name, total: rows.length, cleaned, masterAdded }, rows);
      setHistory(getCleanHistory());
      setStatus('done');
    } catch (e) {
      setError(e.message);
      setStatus('error');
    }
  };

  // ── Mode 2: Clearout verify + clean names ───────────────────────────────

  const parsedDataRef = useRef(null); // Store parsed+cleaned rows between upload and download

  const runFullPipeline = async () => {
    if (!file) return;
    setStatus('uploading');
    setError('');
    setProgress(0);

    // Try same-origin first (hosting rewrites /api/** to Cloud Function), then localhost
    const tryUrls = [api || '', 'http://localhost:3001'].filter((v, i, a) => a.indexOf(v) === i);

    try {
      // Step 1: Parse CSV client-side, clean company names, extract emails-only CSV
      const text = await readFileText(file);
      const { headers, rows } = parseCSVText(text);
      if (!rows.length) throw new Error('Empty CSV');

      const emailCol = detectColumn(headers, ['email', 'email_address', 'emailaddress', 'e-mail', 'mail']);
      if (!emailCol) throw new Error('No email column found');

      const companyCol = detectColumn(headers, ['company', 'company_name', 'companyname', 'organization', 'org']);
      let cleaned = 0;
      if (companyCol) {
        for (const row of rows) {
          const original = row[companyCol] || '';
          const clean = cleanCompanyName(original);
          if (clean !== original) cleaned++;
          if (!row[`${companyCol}_original`]) row[`${companyCol}_original`] = original;
          row[companyCol] = clean;
        }
      }

      // Store cleaned rows for later joining
      parsedDataRef.current = { rows, headers, emailCol, companyCol, cleaned };

      // Build emails-only CSV for Clearout
      const emailCsv = 'email\n' + rows.map(r => r[emailCol] || '').filter(e => e).join('\n');
      const emailFile = new File([emailCsv], 'emails.csv', { type: 'text/csv' });

      // Step 2: Upload emails-only to backend → Clearout
      const form = new FormData();
      form.append('file', emailFile);

      let uploadResp = null;
      for (const base of tryUrls) {
        try {
          const resp = await fetch(`${base}/api/cleaner/verify`, { method: 'POST', body: form });
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('json')) { uploadResp = resp; break; }
        } catch (e) { /* try next */ }
      }
      if (!uploadResp) throw new Error('Cannot reach backend. Run the backend locally: cd backend && npm run dev');
      const uploadData = await uploadResp.json();
      console.log('[cleaner] upload response:', uploadData);
      if (!uploadData.success) throw new Error(uploadData.error || 'Upload failed');

      const listId = uploadData.list_id;
      const workingBase = uploadResp.url.replace('/api/cleaner/verify', '');
      setStatus('verifying');
      startPoll(listId, workingBase);
    } catch (e) {
      setError(e.message);
      setStatus('error');
      if (pollRef.current) clearInterval(pollRef.current);
    }
  };

  const handleSubmit = () => {
    if (mode === 'names') cleanNamesOnly();
    else runFullPipeline();
  };

  // Download result as CSV
  const downloadCSV = () => {
    if (!result?.rows?.length) return;
    const headers = Object.keys(result.rows[0]);
    const csvLines = [
      headers.join(','),
      ...result.rows.map(row =>
        headers.map(h => {
          const v = (row[h] || '').toString();
          return v.includes(',') || v.includes('"') || v.includes('\n')
            ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
      )
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = file?.name?.replace(/\.[^.]+$/, '') || 'leads';
    a.download = `${baseName}_cleaned.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // View a past clean run
  const viewHistoryRun = async (entry) => {
    try {
      const run = await getCleanRun(entry.id);
      if (!run?.rows?.length) { alert('No saved data for this run.'); return; }
      setResult({ rows: run.rows, total: run.rows.length, cleaned: entry.cleaned, valid: entry.valid, totalBeforeFilter: entry.totalBeforeFilter });
    } catch (e) { alert('Failed to load run: ' + e.message); }
  };

  // Download a past clean run as CSV
  const downloadHistoryRun = async (entry) => {
    try {
      const run = await getCleanRun(entry.id);
      if (!run?.rows?.length) { alert('No saved data for this run.'); return; }
      const headers = Object.keys(run.rows[0]);
      const csvLines = [
        headers.join(','),
        ...run.rows.map(row =>
          headers.map(h => {
            const v = (row[h] || '').toString();
            return v.includes(',') || v.includes('"') || v.includes('\n')
              ? `"${v.replace(/"/g, '""')}"` : v;
          }).join(',')
        )
      ];
      const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${entry.fileName?.replace(/\.[^.]+$/, '') || 'clean_run'}_${entry.id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('Failed to download: ' + e.message); }
  };

  // Download master list
  const downloadMaster = async () => {
    const rows = await getAllMasterRows();
    if (!rows.length) return;
    const hdrs = await getMasterHeaders();
    const headers = hdrs.filter(h => h !== '_id' && h !== '_cleaned_at').concat('_cleaned_at');
    const csvLines = [
      headers.join(','),
      ...rows.map(row =>
        headers.map(h => {
          const v = (row[h] || '').toString();
          return v.includes(',') || v.includes('"') || v.includes('\n')
            ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
      )
    ];
    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `master_lead_list_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const viewMaster = async () => {
    if (showMaster) { setShowMaster(false); return; }
    const rows = await getAllMasterRows();
    const hdrs = await getMasterHeaders();
    const displayHeaders = hdrs.filter(h => h !== '_id').slice(0, 8);
    setMasterHeaders(displayHeaders);
    setMasterRows(rows);
    setShowMaster(true);
  };

  const clearMaster = async () => {
    if (confirm('Clear all leads from the master list? This cannot be undone.')) {
      await clearMasterDB();
      setMasterCount(0);
      setShowMaster(false);
      setMasterRows(null);
    }
  };

  const statusLabels = {
    idle: 'Ready',
    uploading: 'Processing...',
    verifying: `Verifying emails... ${progress}%`,
    downloading: 'Downloading valid results...',
    done: 'Complete!',
    error: 'Error',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Lead Cleaner</h1>
        <div className="flex items-center gap-3">
          <div className="glass-card rounded-xl px-4 py-2 flex items-center gap-3">
            <span className="text-sm text-white/40">Master List:</span>
            <span className="font-bold text-brand-400">{masterCount.toLocaleString()}</span>
            <span className="text-sm text-white/30">leads</span>
            {masterCount > 0 && (
              <>
                <button onClick={viewMaster} className="text-sm text-brand-400 font-medium hover:text-brand-300 ml-2 transition-colors">{showMaster ? 'Hide' : 'View'}</button>
                <button onClick={downloadMaster} className="text-sm text-emerald-400 font-medium hover:text-emerald-300 transition-colors">Download</button>
                <button onClick={clearMaster} className="text-sm text-red-400/60 hover:text-red-400 transition-colors">Clear</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Master List Viewer */}
      {showMaster && masterRows && (
        <div className="glass-card rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-bold text-white/90 mb-3">Master Lead List <span className="text-sm font-normal text-white/30">({masterRows.length.toLocaleString()} leads)</span></h2>
          <div className="overflow-x-auto border border-white/10 rounded-xl" style={{ maxHeight: '500px', overflowY: 'auto' }}>
            <table className="w-full text-sm">
              <thead className="bg-white/5 sticky top-0">
                <tr>
                  {masterHeaders.map(h => (
                    <th key={h} className="text-left px-3 py-2 font-medium text-white/40 border-b border-white/10 whitespace-nowrap">{h}</th>
                  ))}
                  {masterHeaders.length < (masterRows[0] ? Object.keys(masterRows[0]).length : 0) && (
                    <th className="text-left px-3 py-2 font-medium text-white/20 border-b border-white/10">...</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {masterRows.slice(0, 100).map((row, i) => (
                  <tr key={row._id || i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    {masterHeaders.map(h => (
                      <td key={h} className="px-3 py-2 text-white/60 truncate max-w-[200px]">{row[h]}</td>
                    ))}
                    {masterHeaders.length < Object.keys(row).length && <td className="px-3 py-2 text-white/20">...</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {masterRows.length > 100 && (
              <p className="text-center text-sm text-white/30 py-2">Showing 100 of {masterRows.length.toLocaleString()} leads</p>
            )}
          </div>
        </div>
      )}

      {/* Mode Toggle */}
      <div className="glass-card rounded-2xl p-6 mb-6">
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setMode('full')}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              mode === 'full'
                ? 'bg-brand-500/20 text-white border border-brand-500/30 shadow-[0_0_12px_rgba(24,86,255,0.15)]'
                : 'bg-white/5 text-white/50 hover:bg-white/10 border border-white/5'
            }`}
          >
            Verify + Clean (Clearout)
          </button>
          <button
            onClick={() => setMode('names')}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              mode === 'names'
                ? 'bg-brand-500/20 text-white border border-brand-500/30 shadow-[0_0_12px_rgba(24,86,255,0.15)]'
                : 'bg-white/5 text-white/50 hover:bg-white/10 border border-white/5'
            }`}
          >
            Clean Company Names Only
          </button>
        </div>

        <p className="text-sm text-white/40 mb-4">
          {mode === 'full'
            ? 'Upload a CSV with emails. Clearout verifies them, then we download only valid emails and clean company names.'
            : 'Upload a CSV. We\'ll strip LLC, Inc, Corp, Ltd, and other legal suffixes from company names.'}
        </p>

        {/* Drop Zone */}
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          className="border-2 border-dashed border-white/15 rounded-2xl p-8 text-center hover:border-brand-500/40 hover:bg-white/3 transition-all cursor-pointer"
          onClick={() => fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleFile}
            className="hidden"
          />
          {file ? (
            <div>
              <p className="text-lg font-medium text-white/90">{file.name}</p>
              <p className="text-sm text-white/40 mt-1">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <div>
              <p className="text-white/40 text-lg">Drop a CSV here or click to browse</p>
              <p className="text-white/20 text-sm mt-1">Supports .csv files</p>
            </div>
          )}
        </div>

        {/* Action Button */}
        <div className="flex gap-3 mt-4">
          <button
            onClick={handleSubmit}
            disabled={!file || (status !== 'idle' && status !== 'done' && status !== 'error')}
            className="glass-btn-primary px-6 py-2.5 rounded-xl font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {mode === 'full' ? 'Verify & Clean' : 'Clean Names'}
          </button>
          {status !== 'idle' && (
            <button onClick={reset} className="px-4 py-2.5 bg-white/5 text-white/50 rounded-xl hover:bg-white/10 border border-white/5 transition-all">
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Status */}
      {status !== 'idle' && (
        <div className="glass-card rounded-2xl p-6 mb-6">
          <div className="flex items-center gap-3">
            {status === 'done' ? (
              <span className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            ) : status === 'error' ? (
              <span className="w-3 h-3 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
            ) : (
              <span className="w-3 h-3 rounded-full bg-brand-500 animate-pulse shadow-[0_0_8px_rgba(24,86,255,0.5)]" />
            )}
            <span className="font-medium text-white/80">{statusLabels[status]}</span>
          </div>

          {status === 'verifying' && (
            <div className="mt-3 w-full bg-white/5 rounded-full h-2.5 border border-white/5">
              <div
                className="bg-gradient-to-r from-brand-500 to-brand-400 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
        </div>
      )}

      {/* Results */}
      {result && status === 'done' && (
        <div className="glass-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white/90">Results</h2>
              <p className="text-sm text-white/40">
                {result.total} {mode === 'full' ? 'valid emails' : 'rows'} &middot; {result.cleaned || 0} company names cleaned
                {result.masterAdded != null && <span> &middot; <span className="text-brand-400 font-medium">{result.masterAdded} new</span> added to master list</span>}
              </p>
            </div>
            <button
              onClick={downloadCSV}
              className="px-5 py-2.5 bg-emerald-500/20 text-emerald-400 rounded-xl font-medium hover:bg-emerald-500/30 border border-emerald-500/20 transition-all"
            >
              Download CSV
            </button>
          </div>

          {/* Preview Table */}
          {result.rows?.length > 0 && (
            <div className="overflow-x-auto border border-white/10 rounded-xl">
              <table className="w-full text-sm">
                <thead className="bg-white/5">
                  <tr>
                    {Object.keys(result.rows[0]).slice(0, 6).map(h => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-white/40 border-b border-white/10">{h}</th>
                    ))}
                    {Object.keys(result.rows[0]).length > 6 && (
                      <th className="text-left px-3 py-2 font-medium text-white/20 border-b border-white/10">+{Object.keys(result.rows[0]).length - 6} more</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 10).map((row, i) => (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                      {Object.keys(result.rows[0]).slice(0, 6).map(h => (
                        <td key={h} className="px-3 py-2 text-white/60 truncate max-w-[200px]">{row[h]}</td>
                      ))}
                      {Object.keys(result.rows[0]).length > 6 && <td className="px-3 py-2 text-white/20">...</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.rows.length > 10 && (
                <p className="text-center text-sm text-white/30 py-2">Showing 10 of {result.rows.length} rows</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Clean History Log */}
      {history.length > 0 && (
        <div className="glass-card rounded-2xl p-6 mt-6">
          <h2 className="text-lg font-bold text-white/90 mb-4">Clean History</h2>
          <div className="space-y-3">
            {history.map(entry => (
              <div key={entry.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <div>
                  <span className={`inline-block px-2 py-0.5 rounded-lg text-xs font-medium mr-2 ${
                    entry.mode === 'verify' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'
                  }`}>
                    {entry.mode === 'verify' ? 'Verify + Clean' : 'Names Only'}
                  </span>
                  {entry.fileName && <span className="text-sm text-white/50">{entry.fileName}</span>}
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-white/40">{entry.total} rows</span>
                  {entry.valid != null && entry.totalBeforeFilter != null && (
                    <span className="text-emerald-400 font-medium">{entry.valid} valid / {entry.totalBeforeFilter}</span>
                  )}
                  <span className="text-brand-400">{entry.cleaned} cleaned</span>
                  <span className="text-white/30">{new Date(entry.timestamp).toLocaleDateString()} {new Date(entry.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                  <button onClick={() => viewHistoryRun(entry)} className="px-2.5 py-1 text-xs font-medium bg-white/5 text-white/50 rounded-lg hover:bg-white/10 border border-white/5 transition-all">View</button>
                  <button onClick={() => downloadHistoryRun(entry)} className="px-2.5 py-1 text-xs font-medium bg-emerald-500/10 text-emerald-400 rounded-lg hover:bg-emerald-500/20 border border-emerald-500/15 transition-all">Download</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

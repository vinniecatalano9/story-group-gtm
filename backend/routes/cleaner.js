const express = require('express');
const router = express.Router();
const multer = require('multer');
const Busboy = require('busboy');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Cloud Functions v2 pre-reads the body, so multer's stream-based parsing fails.
// This middleware handles both environments: rawBody (Cloud Functions) and stream (local).
function parseMultipart(req, res, next) {
  // If multer already parsed it (local dev), skip
  if (req.file) return next();
  // If rawBody exists (Cloud Functions), parse it manually
  if (req.rawBody) {
    const busboy = Busboy({ headers: req.headers });
    const files = {};
    const fields = {};
    busboy.on('file', (fieldname, file, info) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => {
        files[fieldname] = {
          buffer: Buffer.concat(chunks),
          originalname: info.filename,
          mimetype: info.mimeType,
        };
      });
    });
    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('finish', () => {
      req.file = files.file || null;
      req.body = { ...req.body, ...fields };
      next();
    });
    busboy.on('error', (err) => {
      console.error('[cleaner] busboy error:', err);
      res.status(400).json({ error: 'Failed to parse upload' });
    });
    busboy.end(req.rawBody);
  } else {
    // Local dev — use multer
    parseMultipart(req, res, next);
  }
}

const CLEAROUT_API_KEY = () => process.env.CLEAROUT_API_KEY || 'e8e15d3a0b631025b5f6db54a6dc5d93:db992c2a596d6f630f332f9a507a43fa99ab7b8d6eea7213df4134a1294c653d';
const CLEAROUT_BASE = 'https://api.clearout.io/v2';

// ── Company Name Cleaner ────────────────────────────────────────────────────

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
  'l\\.?\\s*p\\.?\\s*a\\.?',
  'l\\.?\\s*p\\.?',
  'p\\.?\\s*c\\.?', 'p\\.?\\s*l\\.?\\s*c\\.?',
  'p\\.?\\s*a\\.?',
  'a\\.?\\s*p\\.?\\s*c\\.?',
  's\\.?\\s*c\\.?',
  'inc\\.?', 'corp\\.?', 'co\\.?', 'ltd\\.?', 'g\\.?\\s*p\\.?',
  's\\.?\\s*a\\.?', 'n\\.?\\s*a\\.?', 's\\.?\\s*r\\.?\\s*l\\.?',
  'gmbh', 'ag', 'pty', 'pvt', 'plc', 'llp', 'llc', 'llo', 'lp',
  'p\\.?\\s*s\\.?\\s*c\\.?',
  'p\\.?\\s*l\\.?\\s*l\\.?\\s*p\\.?',
  'a\\.?\\s*p\\.?\\s*l\\.?\\s*c\\.?',
  'l\\.?\\s*c\\.?',
  'l\\.?\\s*p\\.?\\s*a\\.?',
  'p\\.?\\s*s\\.?',
  'p\\.?\\s*l\\.?',
  'apc', 'pa',
];

const SUFFIX_RE = new RegExp(
  '[\\s,.\\/|\\-]*\\b(?:' + SUFFIXES.join('|') + ')\\s*\\.?\\s*$', 'i'
);
const PAREN_RE = new RegExp(
  '\\s*\\((?:' + SUFFIXES.join('|') + ')\\)\\s*\\.?\\s*', 'i'
);

const DESCRIPTOR_WORDS = /^(?:a\s+|the\s+|an\s+)?(?:personal|attorney|lawyer|legal|law\s+firm|law\s+office|law\s+offices|accident|criminal|family|divorce|immigration|bankruptcy|estate|tax|real\s+estate|business|corporate|employment|civil|trial|appellate|medical|patent|intellectual|insurance|securities|environmental|maritime|labor|workers|wrongful|sexual|discrimination|harassment|defense|prosecution|litigation|counsel|consulting|advisor|practice|specialist|certified|board|experienced|trusted|top|best|premier|leading|award|injury|division|global|international|social\s+security|led\s+by|electronic|hurt|call|class\s+action|healthcare|bridging|colling|america|municipal|bail|reference|western|administrators|network)\b/i;

const POST_SUFFIX_JUNK = /\s+(?:attorneys?\s+at\s+law|attorneys?|lawyers?|law\s+firm|law\s+offices?|injury\s+lawyers?|family\s+law(?:\s+firm)?|healthcare\s+law|class\s+action\s+administrators?|of\s+western\s+.+)$/i;

function fixEncoding(str) {
  let s = str;
  s = s.replace(/[\xAE\xA9\u2122]/g, '');
  s = s.replace(/[\xC3\xC2][\x82\x83]*[\xC2\xC3]*[\xAE\xA9]/g, '');
  s = s.replace(/\xC3\x83\xC2\xC2\xAE/g, '');
  s = s.replace(/\s*\(formerly\s+[^)]*\)/gi, '');
  const tripleEnc = {
    '\xC3\x83\xC3\x82\xC2\xA9': 'e',
    '\xC3\x83\xC3\x82\xC2\xAB': 'e',
    '\xC3\x83\xC3\x82\xC2\xB1': 'n',
    '\xC3\x83\xC3\x82\xC2\xA8': 'e',
    '\xC3\x83\xC3\x82\xC2\xAE': '',
    '\xC3\x83\xC2\x82\xC3\x82\xC2\xAE': '',
  };
  for (const [pattern, replacement] of Object.entries(tripleEnc)) {
    s = s.split(pattern).join(replacement);
  }
  s = s.replace(/Ã©/g, 'e').replace(/Ã¨/g, 'e').replace(/Ã«/g, 'e');
  s = s.replace(/Ã¯/g, 'i').replace(/Ã®/g, 'i');
  s = s.replace(/Ã´/g, 'o').replace(/Ã¶/g, 'o');
  s = s.replace(/Ã¼/g, 'u').replace(/Ã¹/g, 'u').replace(/Ã»/g, 'u');
  s = s.replace(/Ã /g, 'a').replace(/Ã¢/g, 'a').replace(/Ã¤/g, 'a');
  s = s.replace(/Ã§/g, 'c').replace(/Ã±/g, 'n');
  s = s.replace(/[\xC3\xC2][\x80-\xBF]?/g, '');
  s = s.replace(/[ÃÂ]+/g, '');
  s = s.replace(/[^\x20-\x7E]/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'in', 'at', 'by', 'to', 'on', 'or']);
const KEEP_UPPER = new Set(['LLP', 'PC', 'PA', 'SC', 'APC', 'PLC', 'PLLC', 'II', 'III', 'IV']);

function smartTitleCase(str) {
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

function cleanCompanyName(name) {
  if (!name || !name.trim()) return '';
  let c = name.trim();
  c = fixEncoding(c);
  c = c.replace(/\s*\|.*$/, '').trim();
  c = c.replace(/:\s+[A-Z][a-z].*$/, '').trim();
  c = c.replace(/\s+[-–—]\s+(.+)$/i, (match, after) => {
    const words = after.trim().split(/\s+/);
    if (words.length <= 2 && words.every(w => w.length <= 4)) return match;
    if (DESCRIPTOR_WORDS.test(after.trim())) return '';
    if (words.length >= 4) return '';
    return match;
  }).trim();
  c = c.replace(/,?\s+Inc\.?,?\s+.+$/i, '').trim();
  c = c.replace(/,?\s+Corp\.?,?\s+.+$/i, '').trim();
  c = c.replace(/,?\s+LLC,?\s+.+$/i, '').trim();
  c = c.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  c = c.replace(PAREN_RE, ' ').trim();
  c = c.replace(POST_SUFFIX_JUNK, '').trim();
  for (let i = 0; i < 4; i++) {
    const prev = c;
    c = c.replace(SUFFIX_RE, '');
    if (c === prev) break;
  }
  c = c.replace(/[\s,.\-|/]+$/, '').replace(/\s{2,}/g, ' ').trim();
  c = smartTitleCase(c);
  return c;
}

// ── Parse CSV from buffer ───────────────────────────────────────────────────

function parseCSV(buffer) {
  const content = buffer.toString('utf-8').replace(/^\uFEFF/, '');
  return parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
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

function clearoutHeaders() {
  return { 'Authorization': `Bearer ${CLEAROUT_API_KEY()}` };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/cleaner/clean-names — just clean company names (no Clearout)
router.post('/clean-names', parseMultipart, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rows = parseCSV(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: 'Empty CSV' });

    const headers = Object.keys(rows[0]);
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

    res.json({
      success: true,
      total: rows.length,
      cleaned,
      company_column: companyCol,
      headers: [...Object.keys(rows[0])],
      rows,
    });
  } catch (e) {
    console.error('[cleaner] clean-names error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/cleaner/verify — upload to Clearout for bulk verification
router.post('/verify', parseMultipart, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const FormData = require('form-data');
    const formData = new FormData();
    formData.append('file', req.file.buffer, { filename: req.file.originalname, contentType: 'text/csv' });
    formData.append('optimize', 'highest_accuracy');
    formData.append('ignore_duplicate', 'true');
    formData.append('ignore_duplicate_file', 'true');

    const resp = await axios.post(`${CLEAROUT_BASE}/email_verify/bulk`, formData, {
      headers: { ...clearoutHeaders(), ...formData.getHeaders() },
      maxContentLength: Infinity,
    });

    const data = resp.data;
    console.log('[cleaner] Clearout upload response:', JSON.stringify(data));

    // Clearout returns { status: 'success', data: { list_id: '...' } }
    if (data.status !== 'success' && !data.data?.list_id) {
      const msg = data.error?.message || 'Clearout upload failed';
      return res.status(400).json({ error: msg, details: data });
    }

    res.json({ success: true, list_id: data.data.list_id });
  } catch (e) {
    console.error('[cleaner] verify error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/cleaner/status/:listId — poll Clearout verification progress
router.get('/status/:listId', async (req, res) => {
  try {
    const resp = await axios.get(`${CLEAROUT_BASE}/email_verify/bulk/progress_status`, {
      headers: clearoutHeaders(),
      params: { list_id: req.params.listId },
    });

    const data = resp.data;
    console.log('[cleaner] Clearout status:', JSON.stringify(data));

    if (data.status !== 'success') {
      return res.status(400).json({ error: 'Status check failed', details: data });
    }

    // data.data contains: { progress_status, percentile, total_count, ... }
    const info = data.data || {};
    res.json({
      success: true,
      status: info.progress_status || info.status || 'unknown',
      percentage: info.percentile || info.percentage || 0,
      total: info.total_count || 0,
      verified: info.verified_count || 0,
    });
  } catch (e) {
    console.error('[cleaner] status error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/cleaner/download/:listId — download valid results + clean company names
router.get('/download/:listId', async (req, res) => {
  try {
    // Clearout download is POST /download/result
    const resp = await axios.post(`${CLEAROUT_BASE}/download/result`, {
      list_id: req.params.listId,
    }, {
      headers: { ...clearoutHeaders(), 'Content-Type': 'application/json' },
      responseType: 'text',
      maxContentLength: Infinity,
    });

    // Response could be a download URL or direct CSV data
    let csvData;
    try {
      const parsed = JSON.parse(resp.data);
      if (parsed.data?.url) {
        // It returned a download URL — fetch the actual CSV
        const dlResp = await axios.get(parsed.data.url, { responseType: 'text' });
        csvData = dlResp.data;
      } else {
        csvData = resp.data;
      }
    } catch {
      // It's raw CSV
      csvData = resp.data;
    }

    const allRows = parseCSV(Buffer.from(csvData));
    if (!allRows.length) return res.json({ success: true, total: 0, cleaned: 0, rows: [] });

    // Filter to valid emails only
    const statusCol = detectColumn(Object.keys(allRows[0]), ['clearout_status', 'status', 'result', 'email_status', 'verification_status']);
    let rows;
    if (statusCol) {
      rows = allRows.filter(r => {
        const s = (r[statusCol] || '').toLowerCase();
        return s === 'valid' || s === 'safe' || s === 'deliverable';
      });
    } else {
      rows = allRows; // No status column — return all
    }

    const headers = Object.keys(rows[0] || {});
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

    res.json({
      success: true,
      total: rows.length,
      total_before_filter: allRows.length,
      cleaned,
      company_column: companyCol,
      rows,
    });
  } catch (e) {
    console.error('[cleaner] download error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/cleaner/clean-preview — preview company name cleaning
router.post('/clean-preview', express.json(), (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names array required' });
  const results = names.map(n => ({ original: n, cleaned: cleanCompanyName(n) }));
  res.json({ success: true, results });
});

module.exports = router;

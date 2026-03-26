const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');
const FormData = require('form-data') || null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const CLEAROUT_API_KEY = () => process.env.CLEAROUT_API_KEY || 'e8e15d3a0b631025b5f6db54a6dc5d93:db992c2a596d6f630f332f9a507a43fa99ab7b8d6eea7213df4134a1294c653d';
const CLEAROUT_BASE = 'https://app.clearout.io/v2';

// ── Company Name Cleaner ────────────────────────────────────────────────────

const SUFFIXES = [
  'limited\\s+liability\\s+company',
  'limited\\s+liability\\s+partnership',
  'professional\\s+limited\\s+liability\\s+company',
  'professional\\s+corporation',
  'incorporated', 'corporation',
  'limited\\s+partnership', 'limited',
  'general\\s+partnership', 'company',
  'p\\.?l\\.?l\\.?c\\.?', 'l\\.?l\\.?c\\.?', 'l\\.?l\\.?p\\.?',
  'l\\.?p\\.?', 'p\\.?c\\.?', 'p\\.?l\\.?c\\.?',
  'inc\\.?', 'corp\\.?', 'co\\.?', 'ltd\\.?', 'g\\.?p\\.?',
  's\\.?a\\.?', 'n\\.?a\\.?', 's\\.?r\\.?l\\.?',
  'gmbh', 'ag', 'pty', 'pvt', 'plc', 'llp', 'llc', 'lp',
];

const SUFFIX_RE = new RegExp(
  '[\\s,.\\/|\\-]*\\b(?:' + SUFFIXES.join('|') + ')\\s*\\.?\\s*$', 'i'
);
const PAREN_RE = new RegExp(
  '\\s*\\((?:' + SUFFIXES.join('|') + ')\\)\\s*\\.?\\s*', 'i'
);
const TRAILING_JUNK = /[\s,.\-|/]+$/;
const MULTI_SPACE = /\s{2,}/g;

function cleanCompanyName(name) {
  if (!name || !name.trim()) return '';
  let c = name.trim();
  c = c.replace(PAREN_RE, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const prev = c;
    c = c.replace(SUFFIX_RE, '');
    if (c === prev) break;
  }
  c = c.replace(TRAILING_JUNK, '').replace(MULTI_SPACE, ' ').trim();
  return c;
}

// ── Parse CSV from buffer ───────────────────────────────────────────────────

function parseCSV(buffer) {
  const content = buffer.toString('utf-8').replace(/^\uFEFF/, ''); // strip BOM
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
  return { 'Authorization': `Bearer:${CLEAROUT_API_KEY()}` };
}

// ── Routes ──────────────────────────────────────────────────────────────────

// POST /api/cleaner/clean-names — just clean company names (no Clearout)
router.post('/clean-names', upload.single('file'), async (req, res) => {
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
router.post('/verify', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Build multipart form with the file
    const formData = new (require('form-data'))();
    formData.append('file', req.file.buffer, { filename: req.file.originalname, contentType: 'text/csv' });
    formData.append('optimize', 'highest_accuracy');

    const resp = await axios.post(`${CLEAROUT_BASE}/email_verify/bulk`, formData, {
      headers: { ...clearoutHeaders(), ...formData.getHeaders() },
      maxContentLength: Infinity,
    });

    const data = resp.data;
    if (data.status !== 'success') {
      return res.status(400).json({ error: 'Clearout upload failed', details: data });
    }

    res.json({ success: true, list_id: data.data.list_id });
  } catch (e) {
    console.error('[cleaner] verify error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/cleaner/status/:listId — poll Clearout verification status
router.get('/status/:listId', async (req, res) => {
  try {
    const resp = await axios.get(`${CLEAROUT_BASE}/email_verify/bulk/status`, {
      headers: clearoutHeaders(),
      params: { list_id: req.params.listId },
    });

    const data = resp.data;
    if (data.status !== 'success') {
      return res.status(400).json({ error: 'Status check failed', details: data });
    }
    res.json({ success: true, ...data.data });
  } catch (e) {
    console.error('[cleaner] status error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/cleaner/download/:listId — download valid results + clean company names
router.get('/download/:listId', async (req, res) => {
  try {
    const resp = await axios.get(`${CLEAROUT_BASE}/email_verify/bulk/download`, {
      headers: clearoutHeaders(),
      params: { list_id: req.params.listId, filter: 'valid' },
      responseType: 'text',
    });

    const rows = parseCSV(Buffer.from(resp.data));
    if (!rows.length) return res.json({ success: true, total: 0, rows: [] });

    const headers = Object.keys(rows[0]);
    const companyCol = detectColumn(headers, ['company', 'company_name', 'companyname', 'organization', 'org']);
    let cleaned = 0;

    if (companyCol) {
      for (const row of rows) {
        const original = row[companyCol] || '';
        const clean = cleanCompanyName(original);
        if (clean !== original) cleaned++;
        row[companyCol] = clean;
      }
    }

    res.json({
      success: true,
      total: rows.length,
      cleaned,
      company_column: companyCol,
      rows,
    });
  } catch (e) {
    console.error('[cleaner] download error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/cleaner/clean-preview — preview company name cleaning on a few rows
router.post('/clean-preview', express.json(), (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names array required' });
  const results = names.map(n => ({ original: n, cleaned: cleanCompanyName(n) }));
  res.json({ success: true, results });
});

module.exports = router;

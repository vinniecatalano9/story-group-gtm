import { useState, useRef, useCallback } from 'react';

// ── Company Name Cleaner (runs in browser) ──────────────────────────────────

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

function cleanCompanyName(name) {
  if (!name || !name.trim()) return '';
  let c = name.trim();
  c = c.replace(PAREN_RE, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const prev = c;
    c = c.replace(SUFFIX_RE, '');
    if (c === prev) break;
  }
  c = c.replace(/[\s,.\-|/]+$/, '').replace(/\s{2,}/g, ' ').trim();
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

export default function LeadCleaner({ api }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('full');
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const fileRef = useRef();
  const pollRef = useRef(null);

  const reset = () => {
    setFile(null);
    setStatus('idle');
    setProgress(0);
    setResult(null);
    setError('');
    if (pollRef.current) clearInterval(pollRef.current);
    if (fileRef.current) fileRef.current.value = '';
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

      setResult({ total: rows.length, cleaned, company_column: companyCol, rows });
      setStatus('done');
    } catch (e) {
      setError(e.message);
      setStatus('error');
    }
  };

  // ── Mode 2: Clearout verify + clean names ───────────────────────────────

  const runFullPipeline = async () => {
    if (!file) return;
    setStatus('uploading');
    setError('');
    setProgress(0);

    try {
      // Step 1: Upload to backend → Clearout
      const form = new FormData();
      form.append('file', file);

      const uploadResp = await fetch(`${api}/api/cleaner/verify`, { method: 'POST', body: form });
      const uploadData = await uploadResp.json();
      if (!uploadData.success) throw new Error(uploadData.error || 'Upload failed');

      const listId = uploadData.list_id;
      setStatus('verifying');

      // Step 2: Poll for completion via backend
      await new Promise((resolve, reject) => {
        pollRef.current = setInterval(async () => {
          try {
            const resp = await fetch(`${api}/api/cleaner/status/${listId}`);
            const data = await resp.json();
            if (!data.success) { clearInterval(pollRef.current); reject(new Error('Status check failed')); return; }

            const pct = data.percentage || 0;
            setProgress(pct);

            const state = data.status || '';
            if (['completed', 'done', 'finished'].includes(state)) {
              clearInterval(pollRef.current);
              resolve();
            } else if (['failed', 'error'].includes(state)) {
              clearInterval(pollRef.current);
              reject(new Error('Verification failed'));
            }
          } catch (e) { clearInterval(pollRef.current); reject(e); }
        }, 10000);
      });

      // Step 3: Download valid results via backend (already cleans company names)
      setStatus('downloading');
      const dlResp = await fetch(`${api}/api/cleaner/download/${listId}`);
      const dlData = await dlResp.json();
      if (!dlData.success) throw new Error(dlData.error || 'Download failed');

      setResult({ total: dlData.total, cleaned: dlData.cleaned, company_column: dlData.company_column, rows: dlData.rows });
      setStatus('done');
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
      <h1 className="text-2xl font-bold mb-6">Lead Cleaner</h1>

      {/* Mode Toggle */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setMode('full')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === 'full'
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Verify + Clean (Clearout)
          </button>
          <button
            onClick={() => setMode('names')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === 'names'
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Clean Company Names Only
          </button>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          {mode === 'full'
            ? 'Upload a CSV with emails. Clearout verifies them, then we download only valid emails and clean company names.'
            : 'Upload a CSV. We\'ll strip LLC, Inc, Corp, Ltd, and other legal suffixes from company names.'}
        </p>

        {/* Drop Zone */}
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          className="border-2 border-dashed border-gray-300 rounded-xl p-8 text-center hover:border-brand-400 transition-colors cursor-pointer"
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
              <p className="text-lg font-medium text-gray-800">{file.name}</p>
              <p className="text-sm text-gray-500 mt-1">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <div>
              <p className="text-gray-500 text-lg">Drop a CSV here or click to browse</p>
              <p className="text-gray-400 text-sm mt-1">Supports .csv files</p>
            </div>
          )}
        </div>

        {/* Action Button */}
        <div className="flex gap-3 mt-4">
          <button
            onClick={handleSubmit}
            disabled={!file || (status !== 'idle' && status !== 'done' && status !== 'error')}
            className="px-6 py-2.5 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {mode === 'full' ? 'Verify & Clean' : 'Clean Names'}
          </button>
          {status !== 'idle' && (
            <button onClick={reset} className="px-4 py-2.5 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors">
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Status */}
      {status !== 'idle' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-3">
            {status === 'done' ? (
              <span className="w-3 h-3 rounded-full bg-green-500" />
            ) : status === 'error' ? (
              <span className="w-3 h-3 rounded-full bg-red-500" />
            ) : (
              <span className="w-3 h-3 rounded-full bg-brand-500 animate-pulse" />
            )}
            <span className="font-medium text-gray-800">{statusLabels[status]}</span>
          </div>

          {status === 'verifying' && (
            <div className="mt-3 w-full bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-brand-600 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
        </div>
      )}

      {/* Results */}
      {result && status === 'done' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-gray-800">Results</h2>
              <p className="text-sm text-gray-500">
                {result.total} {mode === 'full' ? 'valid emails' : 'rows'} &middot; {result.cleaned || 0} company names cleaned
                {result.company_column && <span> (column: {result.company_column})</span>}
              </p>
            </div>
            <button
              onClick={downloadCSV}
              className="px-5 py-2.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
            >
              Download CSV
            </button>
          </div>

          {/* Preview Table */}
          {result.rows?.length > 0 && (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {Object.keys(result.rows[0]).slice(0, 6).map(h => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 border-b">{h}</th>
                    ))}
                    {Object.keys(result.rows[0]).length > 6 && (
                      <th className="text-left px-3 py-2 font-medium text-gray-400 border-b">+{Object.keys(result.rows[0]).length - 6} more</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.slice(0, 10).map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      {Object.keys(result.rows[0]).slice(0, 6).map(h => (
                        <td key={h} className="px-3 py-2 text-gray-700 truncate max-w-[200px]">{row[h]}</td>
                      ))}
                      {Object.keys(result.rows[0]).length > 6 && <td className="px-3 py-2 text-gray-400">...</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              {result.rows.length > 10 && (
                <p className="text-center text-sm text-gray-400 py-2">Showing 10 of {result.rows.length} rows</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

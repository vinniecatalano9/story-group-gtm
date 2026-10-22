// services/gmailDraft.js — put a draft in vincent@storygroup.io's Gmail through
// scripts/gmail_draft.py (IMAP APPEND to Drafts). Never sends. Resolves true
// when the draft landed.

const path = require('path');
const { execFile } = require('child_process');

function createGmailDraft({ to, subject, body }) {
  return new Promise(resolve => {
    const child = execFile('python3', [path.join(__dirname, '..', 'scripts', 'gmail_draft.py')], { timeout: 90000 }, (err, stdout) => {
      let out = null;
      try { out = JSON.parse(String(stdout).trim()); } catch { /* fall through */ }
      if (err || !out || !out.ok) console.warn('[gmailDraft] Gmail draft failed:', (out && out.error) || (err && err.message));
      resolve(!!(out && out.ok));
    });
    child.stdin.end(JSON.stringify({ to, subject, body }));
  });
}

module.exports = { createGmailDraft };

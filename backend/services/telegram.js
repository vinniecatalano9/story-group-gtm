// services/telegram.js — Vincent's GTM feed on Telegram.
//
// Sends as Work Bot (@vinnie_claude_bot) through the Bot API. sendMessage does
// not touch the bot's own poller, so this is safe while Work Bot runs. The
// token stays root-side: it's read from the bot's channel .env at send time
// (this process runs as root), never copied into the backend .env.
//
// Also drops copies into Work Bot's home (~/gtm-feed) so the bot can answer
// follow-up questions about what was sent.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');

const TOKEN_FILE = () => process.env.WORKBOT_TELEGRAM_ENV || '/home/worker/.claude/channels/telegram/.env';
const CHAT_ID = () => process.env.FEED_TELEGRAM_CHAT || '1027800577';
const FEED_DIR = () => process.env.WORKBOT_FEED_DIR || '/home/worker/gtm-feed';
const RECENT = () => process.env.WORKBOT_RECENT || '/home/worker/agent/recent.md';

function token() {
  const m = fs.readFileSync(TOKEN_FILE(), 'utf8').match(/^TELEGRAM_BOT_TOKEN=["']?([0-9]+:[A-Za-z0-9_-]+)/m);
  if (!m) throw new Error('Work Bot token not found');
  return m[1];
}

function isConfigured() {
  try { token(); return true; } catch { return false; }
}

// Telegram caps a message at 4096 chars. Split on line breaks.
function chunks(text, max = 3800) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + (line.length > max ? line.slice(0, max) : line);
  }
  if (cur) out.push(cur);
  return out;
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTelegram(text, { html = false, silent = false } = {}) {
  const url = `https://api.telegram.org/bot${token()}/sendMessage`;
  for (const part of chunks(text)) {
    const body = { chat_id: CHAT_ID(), text: part, disable_web_page_preview: true, disable_notification: silent };
    if (html) body.parse_mode = 'HTML';
    const r = await axios.post(url, body, { timeout: 30000, validateStatus: () => true });
    if (!r.data?.ok) throw new Error(`Telegram send failed (${r.status}): ${r.data?.description || 'no detail'}`);
  }
}

function workerIds() {
  const uid = Number(execFileSync('id', ['-u', 'worker']).toString().trim());
  const gid = Number(execFileSync('id', ['-g', 'worker']).toString().trim());
  return { uid, gid };
}

/** Write a file under Work Bot's ~/gtm-feed, owned by worker. Best effort. */
function dropForWorkBot(rel, content) {
  try {
    const { uid, gid } = workerIds();
    const p = path.join(FEED_DIR(), rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    fs.chownSync(path.dirname(p), uid, gid);
    fs.chownSync(p, uid, gid);
    return p;
  } catch (e) {
    console.warn('[telegram] Drop for Work Bot failed:', e.message);
    return null;
  }
}

/** One line in Work Bot's memory, so it knows what reached Vincent outside its chat. */
function noteForWorkBot(line) {
  try {
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
    const time = now.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
    fs.appendFileSync(RECENT(), `- ${day} ${time} CT: ${line}\n`);
  } catch (e) {
    console.warn('[telegram] Work Bot memory note failed:', e.message);
  }
}

module.exports = { sendTelegram, isConfigured, escapeHtml, dropForWorkBot, noteForWorkBot, chunks };

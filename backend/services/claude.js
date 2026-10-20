const { execFile } = require('child_process');

// Which LLM runs every prompt in the backend. Switch by editing .env, no code change:
//   LLM_PROVIDER=claude-cli (default) | anthropic | openai | gemini
//   LLM_FALLBACK_PROVIDER=<provider> optional; used when the main provider fails
// Keys and models: ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL), OPENAI_API_KEY + OPENAI_MODEL,
// GEMINI_API_KEY + GEMINI_MODEL.
const CLAUDE_PATH = () => process.env.CLAUDE_PATH || '/root/.local/bin/claude';
const PROVIDER = () => (process.env.LLM_PROVIDER || 'claude-cli').toLowerCase();
const FALLBACK = () => (process.env.LLM_FALLBACK_PROVIDER || '').toLowerCase();

const ANTHROPIC_MODELS = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' };

/** Claude Code CLI (claude -p). Needs a logged-in Claude account on the box. */
function runCli(prompt, { timeout, model }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_PATH(),
      ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])],
      { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: process.env.CLAUDE_HOME || '/root' } },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[claude] Error:', error.message, '| killed:', error.killed, '| signal:', error.signal, '| code:', error.code);
          if (stderr) console.error('[claude] Stderr:', String(stderr).slice(0, 500));
          if (stdout) console.error('[claude] Stdout(partial):', String(stdout).slice(0, 300));
          return reject(new Error(`Claude CLI failed: ${error.message}${error.killed ? ' (killed/timeout)' : ''}`));
        }
        resolve(stdout.trim());
      }
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function postJSON(url, headers, body, timeout) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return data;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// Callers pass short names like 'sonnet'. OpenAI and Gemini ignore them and use their *_MODEL env var.
const PROVIDERS = {
  'claude-cli': runCli,

  async anthropic(prompt, { maxTokens, timeout, model }) {
    const id = ANTHROPIC_MODELS[model] || model || process.env.ANTHROPIC_MODEL || ANTHROPIC_MODELS.opus;
    const data = await postJSON(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': requireEnv('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      { model: id, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
      timeout
    );
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  },

  async openai(prompt, { maxTokens, timeout }) {
    const data = await postJSON(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${requireEnv('OPENAI_API_KEY')}` },
      { model: requireEnv('OPENAI_MODEL'), max_completion_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
      timeout
    );
    return (data.choices?.[0]?.message?.content || '').trim();
  },

  async gemini(prompt, { maxTokens, timeout }) {
    const model = requireEnv('GEMINI_MODEL');
    const data = await postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { 'x-goog-api-key': requireEnv('GEMINI_API_KEY') },
      { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } },
      timeout
    );
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  },
};

async function runProvider(name, prompt, opts) {
  const fn = PROVIDERS[name];
  if (!fn) throw new Error(`Unknown LLM_PROVIDER "${name}"`);
  const out = await fn(prompt, opts);
  if (!out) throw new Error(`${name} returned an empty response`);
  return out;
}

/**
 * Run a prompt through the configured LLM (Claude Code CLI by default).
 * Returns the raw text output.
 */
async function claudePrompt(prompt, { maxTokens = 4096, timeout = 120000, model = null } = {}) {
  const opts = { maxTokens, timeout, model };
  try {
    return await runProvider(PROVIDER(), prompt, opts);
  } catch (err) {
    const fallback = FALLBACK();
    if (!fallback || fallback === PROVIDER()) throw err;
    console.warn(`[llm] ${PROVIDER()} failed (${err.message}); trying ${fallback}`);
    return runProvider(fallback, prompt, opts);
  }
}

/**
 * Run a prompt and parse the response as JSON.
 * The prompt should instruct the model to return valid JSON.
 */
async function claudeJSON(prompt, options = {}) {
  const raw = await claudePrompt(prompt, options);
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
  const jsonStr = jsonMatch[1].trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[claude] Failed to parse JSON:', jsonStr.substring(0, 200));
    throw new Error(`Claude returned invalid JSON: ${e.message}`);
  }
}

module.exports = { claudePrompt, claudeJSON };

const { execFile } = require('child_process');

const CLAUDE_PATH = process.env.CLAUDE_PATH || '/root/.local/bin/claude';

/**
 * Run a prompt through Claude Code CLI (claude -p).
 * Returns the raw text output.
 */
function claudePrompt(prompt, { maxTokens = 4096, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_PATH,
      ['-p', '--output-format', 'text'],
      { timeout, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: '/root' } },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[claude] Error:', error.message);
          if (stderr) console.error('[claude] Stderr:', stderr);
          return reject(new Error(`Claude CLI failed: ${error.message}`));
        }
        resolve(stdout.trim());
      }
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Run a prompt and parse the response as JSON.
 * The prompt should instruct Claude to return valid JSON.
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

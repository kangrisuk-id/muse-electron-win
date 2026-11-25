'use strict';

/**
 * make.fun pipeline: bundle -> check -> submit, driven through the
 * competition kit's CLI (node <kit>/cli/makefun.mjs ...).
 *
 * Pure Node (child_process/fs/path only) so it is unit-testable without
 * Electron; main.js wires it to IPC and settings.
 *
 * What the Stage 1b proof established, and this module encodes:
 *   - bundles from this app declare --harness claude-code
 *     --harness-version 2.1.0 (the bundler classifies the recorded
 *     session by its line format and refuses a contradicting harness);
 *   - the recorded `system` line is NOT a carrier the kit's claude-code
 *     reader counts as the session's system prompt, so the prompt is
 *     extracted verbatim from the session file and passed explicitly
 *     with --system-prompt;
 *   - --prompt-origin typed is accepted for these sessions: the first
 *     user line of a recorded session IS the prompt the user typed in
 *     the app, and it is extracted verbatim into --prompt-file so the
 *     bundler's match against the transcript is exact.
 *
 * The keypair file is only ever passed to the kit CLI by path; this
 * module never reads it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const BUNDLE_FILENAME = '.makefun-bundle.tar.gz';
const HARNESS = 'claude-code';
const HARNESS_VERSION = '2.1.0';
const DEFAULT_EFFORT = 'default';

/* ------------------------------------------------------------------ */
/* Session files                                                       */
/* ------------------------------------------------------------------ */

/** Parse JSONL session text into entries, skipping torn lines. */
function parseSessionEntries(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch (_) { /* skip torn line */ }
  }
  return entries;
}

/** Plain text of a message content: a string, or its text blocks joined. */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function isToolResultOnly(content) {
  return Array.isArray(content) && content.length > 0
    && content.every((b) => b && b.type === 'tool_result');
}

/**
 * Read a recorded session file.
 * @returns {{file: string, entries: object[], meta: object}}
 *   meta is the session header's meta ({id, createdAt, cwd, provider,
 *   model}), falling back to fields carried on the entries themselves.
 */
function readSessionFile(file) {
  const entries = parseSessionEntries(fs.readFileSync(file, 'utf8'));
  const head = entries.find((e) => e && e.type === 'session');
  const meta = { ...(head && head.meta ? head.meta : {}) };
  if (!meta.provider || !meta.model) {
    const carrier = entries.find((e) => e && (e.provider || e.model));
    if (carrier) {
      if (!meta.provider) meta.provider = carrier.provider || '';
      if (!meta.model) meta.model = carrier.model || '';
    }
  }
  if (!meta.id) meta.id = head ? head.sessionId || '' : '';
  if (!meta.cwd) meta.cwd = head ? head.cwd || '' : '';
  return { file, entries, meta };
}

/**
 * The system prompt recorded at the session's start (the `system`
 * entry), verbatim. Returns null when the session recorded none.
 */
function extractSystemPrompt(entries) {
  for (const e of entries || []) {
    if (e && e.type === 'system' && e.message) {
      const text = contentText(e.message.content);
      if (text) return text;
    }
  }
  return null;
}

/**
 * The first real user prompt of the session (skipping tool_result-only
 * user lines), verbatim. Returns null when there is none.
 */
function extractFirstUserPrompt(entries) {
  for (const e of entries || []) {
    if (!e || e.type !== 'user' || !e.message) continue;
    if (isToolResultOnly(e.message.content)) continue;
    const text = contentText(e.message.content);
    if (text) return text;
  }
  return null;
}

/**
 * Sessions recorded into a workspace (its .agent-sessions mirror),
 * newest first: [{file, id, createdAt, provider, model, preview,
 * hasSystemPrompt}].
 */
function listWorkspaceSessions(workspace) {
  const dir = path.join(workspace || '', '.agent-sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      const { entries, meta } = readSessionFile(file);
      out.push({
        file,
        id: meta.id || name.slice(0, -'.jsonl'.length),
        createdAt: meta.createdAt || '',
        provider: meta.provider || '',
        model: meta.model || '',
        preview: (extractFirstUserPrompt(entries) || '').slice(0, 80),
        hasSystemPrompt: !!extractSystemPrompt(entries),
      });
    } catch (_) { /* unreadable session file: skip it */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/* ------------------------------------------------------------------ */
/* Provider -> kit vendor mapping                                      */
/* ------------------------------------------------------------------ */

/** NVIDIA NIM model-id prefixes whose kit vendor differs from the prefix. */
const NVIDIA_VENDOR_BY_PREFIX = {
  meta: 'meta',
  qwen: 'alibaba',
  'deepseek-ai': 'deepseek',
  moonshotai: 'moonshot',
};

/**
 * The --provider value the kit bundler expects for a session recorded
 * under one of the app's providers.
 *   gemini     -> google
 *   openai     -> openai
 *   openrouter -> the vendor prefix of the model id (anthropic/... ->
 *                 anthropic); 'openrouter' when the id has no prefix
 *   nvidia     -> vendor from the model id via NVIDIA_VENDOR_BY_PREFIX;
 *                 'nvidia' when unmapped
 * Unknown vendors are the bundler's call: its error is surfaced verbatim
 * by the runners below.
 */
function vendorFor(providerId, model) {
  const m = String(model || '');
  const prefix = m.includes('/') ? m.split('/')[0] : '';
  switch (providerId) {
    case 'gemini':
      return 'google';
    case 'openai':
      return 'openai';
    case 'openrouter':
      return prefix || 'openrouter';
    case 'nvidia':
      return NVIDIA_VENDOR_BY_PREFIX[prefix] || 'nvidia';
    default:
      return prefix || String(providerId || 'unknown');
  }
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/** Expand a leading ~ to the user's home directory. */
function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function defaultKeypairPath() {
  return path.join(os.homedir(), '.makefun', 'makefun-keypair.json');
}

/** The keypair path from settings, or the default. Path only — the
 *  file's contents are never read by this app. */
function resolveKeypairPath(settings) {
  const configured = settings && settings.makefun ? settings.makefun.keypairPath : '';
  return expandHome(configured && configured.trim() ? configured.trim() : defaultKeypairPath());
}

/**
 * Locate the kit CLI inside a kit directory: <kit>/cli/makefun.mjs,
 * falling back to <kit>/makefun.mjs. Throws when neither exists.
 */
function resolveKitCli(kitDir) {
  const dir = expandHome(String(kitDir || '').trim());
  if (!dir) throw new Error('Folder kit belum diisi.');
  const candidates = [path.join(dir, 'cli', 'makefun.mjs'), path.join(dir, 'makefun.mjs')];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('CLI kit tidak ditemukan di ' + dir + ' (dicari: cli/makefun.mjs atau makefun.mjs).');
}

/** The kit directory a resolved CLI path belongs to (the CLI's cwd). */
function kitDirOf(cli) {
  const dir = path.dirname(cli);
  return path.basename(dir) === 'cli' ? path.dirname(dir) : dir;
}

/* ------------------------------------------------------------------ */
/* Command construction (pure — unit-tested)                           */
/* ------------------------------------------------------------------ */

function buildBundleArgs(opts) {
  const args = [
    'bundle',
    '--repo', opts.workspace,
    '--no-discover',
    '--session', opts.sessionFile,
    '--prompt-file', opts.promptFile,
    '--prompt-origin', opts.promptOrigin || 'typed',
  ];
  if (opts.promptVia) args.push('--prompt-via', opts.promptVia);
  args.push(
    '--system-prompt', opts.systemPromptFile,
    '--harness', HARNESS,
    '--harness-version', HARNESS_VERSION,
    '--provider', opts.provider,
    '--model', opts.model,
    '--effort', opts.effort || DEFAULT_EFFORT,
    '--mcp', 'none',
    '--out', opts.outPath
  );
  return args;
}

function buildCheckArgs(opts) {
  const args = ['check', '--repo', opts.workspace];
  if (opts.commit) args.push('--commit', opts.commit);
  args.push('--transcripts', opts.transcripts);
  return args;
}

function buildSubmitArgs(opts) {
  return [
    'submit',
    '--competition', opts.competition,
    '--repo-url', opts.repoUrl,
    '--commit', opts.commit,
    '--bundle', opts.bundlePath,
    '--keypair', opts.keypairPath,
    '--title', opts.title,
    '--json',
  ];
}

/* ------------------------------------------------------------------ */
/* Output parsing (pure — unit-tested)                                 */
/* ------------------------------------------------------------------ */

const CHECK_LINE_RE = /^(pass|FAIL|skip|at submission)\s+(\S+)\s+(.*)$/;
const CHECK_SUMMARY_RE = /(\d+) passed, (\d+) failed, (\d+) skipped, (\d+) checked at submission/;
const NOT_READY_RE = /^not ready: fix (.+), then check again/;

/**
 * Parse `makefun check` output into a structured result.
 * Per-check lines look like:
 *   pass  competition_open  <reason>
 *   FAIL  thinking_priced   <reason>
 *   skip  thinking_committed  <reason>
 *   at submission  repo_public  <reason>
 * followed by "N passed, M failed, K skipped, J checked at submission"
 * and a verdict line ("ok: ..." or "not ready: fix a, b, then ...").
 */
function parseCheckOutput(text) {
  const checks = [];
  let summary = null;
  let verdictLine = '';
  let ok = false;
  const failedFromVerdict = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trimEnd();
    const m = CHECK_LINE_RE.exec(line);
    if (m) {
      const status = m[1] === 'FAIL' ? 'fail'
        : m[1] === 'at submission' ? 'submission'
        : m[1];
      checks.push({ status, name: m[2], reason: m[3] || '' });
      continue;
    }
    const s = CHECK_SUMMARY_RE.exec(line);
    if (s) {
      summary = {
        passed: Number(s[1]), failed: Number(s[2]),
        skipped: Number(s[3]), atSubmission: Number(s[4]),
      };
      continue;
    }
    if (line.startsWith('ok:')) { ok = true; verdictLine = line; continue; }
    const nr = NOT_READY_RE.exec(line);
    if (nr) {
      verdictLine = line;
      for (const name of nr[1].split(',')) failedFromVerdict.push(name.trim());
    }
  }
  const failedNames = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  for (const name of failedFromVerdict) {
    if (!failedNames.includes(name)) failedNames.push(name);
  }
  if (!summary) {
    summary = {
      passed: checks.filter((c) => c.status === 'pass').length,
      failed: checks.filter((c) => c.status === 'fail').length,
      skipped: checks.filter((c) => c.status === 'skip').length,
      atSubmission: checks.filter((c) => c.status === 'submission').length,
    };
  }
  return { checks, passed: summary.passed, failed: summary.failed,
    skipped: summary.skipped, atSubmission: summary.atSubmission,
    failedNames, ok, verdictLine };
}

/** Pull the submission id / claim code out of `submit --json` output. */
function parseSubmitOutput(text) {
  const out = { submissionId: '', claimCode: '', checkedLine: '' };
  const sid = /"submission_id":\s*"([^"]+)"/.exec(String(text || ''));
  if (sid) out.submissionId = sid[1];
  const cc = /"claim_code":\s*"([^"]+)"/.exec(String(text || ''));
  if (cc) out.claimCode = cc[1];
  const cl = /^checked: .*$/m.exec(String(text || ''));
  if (cl) out.checkedLine = cl[0];
  return out;
}

/* ------------------------------------------------------------------ */
/* Process running                                                     */
/* ------------------------------------------------------------------ */

/**
 * Run a Node script with spawn (no shell), streaming each output line
 * to onLine({stream, line}) as it arrives.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runNodeScript(script, args, opts) {
  opts = opts || {};
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : () => {};
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: opts.cwd || undefined,
      shell: false,
      env: process.env,
    });
    const buffers = { stdout: '', stderr: '' };
    const remainders = { stdout: '', stderr: '' };
    const pump = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      buffers[stream] += text;
      const parts = (remainders[stream] + text).split('\n');
      remainders[stream] = parts.pop();
      for (const line of parts) onLine({ stream, line });
    };
    child.stdout.on('data', pump('stdout'));
    child.stderr.on('data', pump('stderr'));
    child.on('error', reject);
    child.on('close', (code) => {
      for (const stream of ['stdout', 'stderr']) {
        if (remainders[stream]) onLine({ stream, line: remainders[stream] });
      }
      resolve({ code, stdout: buffers.stdout, stderr: buffers.stderr });
    });
  });
}

/** Current git HEAD of a workspace, or null when it is not a repo. */
function gitHead(workspace) {
  return new Promise((resolve) => {
    execFile('git', ['-C', workspace, 'rev-parse', 'HEAD'], { shell: false }, (err, stdout) => {
      if (err) return resolve(null);
      const sha = String(stdout || '').trim();
      resolve(/^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Pipeline steps                                                      */
/* ------------------------------------------------------------------ */

/**
 * Extract the prompt + system prompt of a recorded session into a fresh
 * temp directory, ready for --prompt-file / --system-prompt.
 * @returns {{tmpDir, promptFile, systemPromptFile, provider, model,
 *            vendor, prompt, systemPrompt, meta}}
 */
function prepareBundleFiles(sessionFile) {
  const { entries, meta } = readSessionFile(sessionFile);
  const systemPrompt = extractSystemPrompt(entries);
  if (!systemPrompt) {
    throw new Error('Sesi ini tidak merekam system prompt (tidak ada baris "system"). Rekam sesi baru dengan versi aplikasi ini.');
  }
  const prompt = extractFirstUserPrompt(entries);
  if (!prompt) {
    throw new Error('Sesi ini tidak punya baris prompt user pertama.');
  }
  if (!meta.provider || !meta.model) {
    throw new Error('Header sesi tidak mencantumkan provider/model.');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-makefun-'));
  const promptFile = path.join(tmpDir, 'prompt.txt');
  const systemPromptFile = path.join(tmpDir, 'system-prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  fs.writeFileSync(systemPromptFile, systemPrompt, 'utf8');
  return {
    tmpDir, promptFile, systemPromptFile, prompt, systemPrompt, meta,
    provider: meta.provider, model: meta.model,
    vendor: vendorFor(meta.provider, meta.model),
  };
}

/**
 * Bundle a recorded session against a workspace repo.
 * opts: {workspace, kitDir, sessionFile, outPath?, promptOrigin?,
 *        promptVia?, effort?}
 * Resolves with the run result plus the constructed command; a nonzero
 * exit code is reported, not thrown (the CLI's own words are in
 * stdout/stderr for the log view).
 */
async function runBundle(opts, onLine) {
  const cli = resolveKitCli(opts.kitDir);
  const prep = prepareBundleFiles(opts.sessionFile);
  const outPath = opts.outPath || path.join(opts.workspace, BUNDLE_FILENAME);
  const args = buildBundleArgs({
    workspace: opts.workspace,
    sessionFile: opts.sessionFile,
    promptFile: prep.promptFile,
    systemPromptFile: prep.systemPromptFile,
    promptOrigin: opts.promptOrigin,
    promptVia: opts.promptVia,
    provider: prep.vendor,
    model: prep.model,
    effort: opts.effort,
    outPath,
  });
  try {
    const res = await runNodeScript(cli, args, { cwd: kitDirOf(cli), onLine });
    return { ...res, args, outPath, vendor: prep.vendor, model: prep.model };
  } finally {
    try { fs.rmSync(prep.tmpDir, { recursive: true, force: true }); } catch (_) { /* temp cleanup is best-effort */ }
  }
}

/**
 * Run the kit's local check over a bundle.
 * opts: {workspace, kitDir, transcripts, commit?} — commit defaults to
 * the workspace's git HEAD.
 */
async function runCheck(opts, onLine) {
  const cli = resolveKitCli(opts.kitDir);
  const commit = opts.commit || (await gitHead(opts.workspace));
  const args = buildCheckArgs({ workspace: opts.workspace, transcripts: opts.transcripts, commit });
  const res = await runNodeScript(cli, args, { cwd: kitDirOf(cli), onLine });
  return { ...res, args, commit, parsed: parseCheckOutput(res.stdout + '\n' + res.stderr) };
}

/**
 * Submit a bundle. This is the only step that talks to make.fun; it is
 * invoked solely from the UI's deliberate confirm action.
 * opts: {kitDir, competition, repoUrl, commit, bundlePath, keypairPath,
 *        title}
 */
async function runSubmit(opts, onLine) {
  const cli = resolveKitCli(opts.kitDir);
  const args = buildSubmitArgs(opts);
  const res = await runNodeScript(cli, args, { cwd: kitDirOf(cli), onLine });
  return { ...res, args, ...parseSubmitOutput(res.stdout + '\n' + res.stderr) };
}

module.exports = {
  BUNDLE_FILENAME,
  HARNESS,
  HARNESS_VERSION,
  parseSessionEntries,
  readSessionFile,
  extractSystemPrompt,
  extractFirstUserPrompt,
  listWorkspaceSessions,
  vendorFor,
  expandHome,
  defaultKeypairPath,
  resolveKeypairPath,
  resolveKitCli,
  kitDirOf,
  buildBundleArgs,
  buildCheckArgs,
  buildSubmitArgs,
  parseCheckOutput,
  parseSubmitOutput,
  runNodeScript,
  gitHead,
  prepareBundleFiles,
  runBundle,
  runCheck,
  runSubmit,
};

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BUNDLE_FILENAME,
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
  prepareBundleFiles,
  runBundle,
  runCheck,
} = require('../src/makefun');
const { SessionStore } = require('../src/sessions');

/* ------------------------- vendor mapping -------------------------- */

test('vendorFor maps app providers to the kit bundler vendors', () => {
  assert.equal(vendorFor('gemini', 'gemini-3.5-flash'), 'google');
  assert.equal(vendorFor('gemini', 'gemini-2.5-pro'), 'google');
  assert.equal(vendorFor('openai', 'gpt-4o'), 'openai');
  assert.equal(vendorFor('openai', 'o3'), 'openai');
});

test('vendorFor takes the vendor from OpenRouter model id prefixes', () => {
  assert.equal(vendorFor('openrouter', 'anthropic/claude-sonnet-4'), 'anthropic');
  assert.equal(vendorFor('openrouter', 'google/gemini-2.5-pro'), 'google');
  assert.equal(vendorFor('openrouter', 'openai/gpt-4o'), 'openai');
  assert.equal(vendorFor('openrouter', 'model-tanpa-prefix'), 'openrouter');
  assert.equal(vendorFor('openrouter', ''), 'openrouter');
});

test('vendorFor maps NVIDIA NIM model ids to their kit vendors', () => {
  assert.equal(vendorFor('nvidia', 'meta/llama-3.3-70b-instruct'), 'meta');
  assert.equal(vendorFor('nvidia', 'qwen/qwen3-coder-480b-a35b-instruct'), 'alibaba');
  assert.equal(vendorFor('nvidia', 'deepseek-ai/deepseek-r1'), 'deepseek');
  assert.equal(vendorFor('nvidia', 'moonshotai/kimi-k2-instruct'), 'moonshot');
  assert.equal(vendorFor('nvidia', 'nvidia/nemotron-3-super-120b'), 'nvidia');
  assert.equal(vendorFor('nvidia', 'model-tanpa-prefix'), 'nvidia');
});

/* ----------------------- prompt extraction ------------------------- */

function sampleEntries() {
  return [
    { type: 'session', sessionId: 's1', meta: { id: 's1', cwd: '/ws', provider: 'gemini', model: 'gemini-3.5-flash' } },
    { type: 'system', message: { role: 'system', content: 'SYSTEM PROMPT PERSIS\nbaris kedua' } },
    { type: 'user', message: { role: 'user', content: 'buatkan entry fridge' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'siap' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: 'lanjutkan' } },
  ];
}

test('extractSystemPrompt returns the recorded system entry verbatim', () => {
  assert.equal(extractSystemPrompt(sampleEntries()), 'SYSTEM PROMPT PERSIS\nbaris kedua');
  assert.equal(extractSystemPrompt([{ type: 'user', message: { content: 'x' } }]), null);
  assert.equal(extractSystemPrompt([]), null);
});

test('extractFirstUserPrompt returns the first real prompt, skipping tool results', () => {
  assert.equal(extractFirstUserPrompt(sampleEntries()), 'buatkan entry fridge');
  const toolFirst = [
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'prompt blok' }] } },
  ];
  assert.equal(extractFirstUserPrompt(toolFirst), 'prompt blok');
  assert.equal(extractFirstUserPrompt([]), null);
});

test('readSessionFile + prepareBundleFiles work on a real recorded session', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-userdata-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ws-'));
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'nvidia', model: 'qwen/qwen3-coder-480b-a35b-instruct' });
  store.append(meta, 'system', { message: { role: 'system', content: 'SYS-EXACT' } });
  store.append(meta, 'user', { message: { role: 'user', content: 'prompt user persis' } });

  const file = path.join(userData, 'sessions', meta.id + '.jsonl');
  const read = readSessionFile(file);
  assert.equal(read.meta.provider, 'nvidia');
  assert.equal(read.meta.model, 'qwen/qwen3-coder-480b-a35b-instruct');
  assert.equal(read.entries.length, 3);

  const prep = prepareBundleFiles(file);
  assert.equal(prep.vendor, 'alibaba');
  assert.equal(fs.readFileSync(prep.promptFile, 'utf8'), 'prompt user persis');
  assert.equal(fs.readFileSync(prep.systemPromptFile, 'utf8'), 'SYS-EXACT');
  fs.rmSync(prep.tmpDir, { recursive: true, force: true });
});

test('prepareBundleFiles refuses a session with no recorded system prompt', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-userdata-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ws-'));
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'gemini', model: 'gemini-3.5-flash' });
  store.append(meta, 'user', { message: { role: 'user', content: 'halo' } });
  assert.throws(
    () => prepareBundleFiles(path.join(userData, 'sessions', meta.id + '.jsonl')),
    /system prompt/
  );
});

test('parseSessionEntries skips torn lines', () => {
  const entries = parseSessionEntries('{"type":"session"}\n{"type":"brok\n{"type":"user"}\n');
  assert.deepEqual(entries.map((e) => e.type), ['session', 'user']);
});

test('listWorkspaceSessions reads the workspace mirror', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-userdata-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ws-'));
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'gemini', model: 'gemini-3.5-flash' });
  store.append(meta, 'system', { message: { role: 'system', content: 'SYS' } });
  store.append(meta, 'user', { message: { role: 'user', content: 'prompt untuk daftar' } });

  const list = listWorkspaceSessions(workspace);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, meta.id);
  assert.equal(list[0].provider, 'gemini');
  assert.equal(list[0].preview, 'prompt untuk daftar');
  assert.equal(list[0].hasSystemPrompt, true);
  assert.deepEqual(listWorkspaceSessions(path.join(workspace, 'tidak-ada')), []);
});

/* ------------------------------ paths ------------------------------ */

test('expandHome and keypair path resolution never touch file contents', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/.makefun/makefun-keypair.json'), path.join(os.homedir(), '.makefun', 'makefun-keypair.json'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(defaultKeypairPath(), path.join(os.homedir(), '.makefun', 'makefun-keypair.json'));
  assert.equal(resolveKeypairPath({}), defaultKeypairPath());
  assert.equal(resolveKeypairPath({ makefun: {} }), defaultKeypairPath());
  assert.equal(
    resolveKeypairPath({ makefun: { keypairPath: '~/keys/agent.json' } }),
    path.join(os.homedir(), 'keys', 'agent.json')
  );
});

test('resolveKitCli finds cli/makefun.mjs, falls back to makefun.mjs', () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-kit-'));
  assert.throws(() => resolveKitCli(kit), /tidak ditemukan/);
  fs.writeFileSync(path.join(kit, 'makefun.mjs'), '// root cli');
  assert.equal(resolveKitCli(kit), path.join(kit, 'makefun.mjs'));
  fs.mkdirSync(path.join(kit, 'cli'));
  fs.writeFileSync(path.join(kit, 'cli', 'makefun.mjs'), '// cli');
  assert.equal(resolveKitCli(kit), path.join(kit, 'cli', 'makefun.mjs'));
  assert.equal(kitDirOf(path.join(kit, 'cli', 'makefun.mjs')), kit);
  assert.equal(kitDirOf(path.join(kit, 'makefun.mjs')), kit);
  assert.throws(() => resolveKitCli(''), /belum diisi/);
});

/* ------------------------ command construction --------------------- */

test('buildBundleArgs produces the proven bundle command shape', () => {
  const args = buildBundleArgs({
    workspace: '/ws/repo',
    sessionFile: '/ws/.agent-sessions/s1.jsonl',
    promptFile: '/tmp/x/prompt.txt',
    systemPromptFile: '/tmp/x/system-prompt.txt',
    provider: 'google',
    model: 'gemini-3.5-flash',
    outPath: '/ws/repo/' + BUNDLE_FILENAME,
  });
  assert.deepEqual(args, [
    'bundle',
    '--repo', '/ws/repo',
    '--no-discover',
    '--session', '/ws/.agent-sessions/s1.jsonl',
    '--prompt-file', '/tmp/x/prompt.txt',
    '--prompt-origin', 'typed',
    '--system-prompt', '/tmp/x/system-prompt.txt',
    '--harness', 'claude-code',
    '--harness-version', '2.1.0',
    '--provider', 'google',
    '--model', 'gemini-3.5-flash',
    '--effort', 'default',
    '--mcp', 'none',
    '--out', '/ws/repo/.makefun-bundle.tar.gz',
  ]);
});

test('buildBundleArgs supports the handed-off fallback with prompt-via', () => {
  const args = buildBundleArgs({
    workspace: '/ws', sessionFile: '/s.jsonl', promptFile: '/p.txt',
    systemPromptFile: '/sp.txt', provider: 'meta', model: 'm',
    outPath: '/o.tar.gz', promptOrigin: 'handed-off', promptVia: 'user tapped approve',
  });
  const i = args.indexOf('--prompt-origin');
  assert.equal(args[i + 1], 'handed-off');
  assert.equal(args[args.indexOf('--prompt-via') + 1], 'user tapped approve');
});

test('buildCheckArgs and buildSubmitArgs shapes', () => {
  assert.deepEqual(
    buildCheckArgs({ workspace: '/ws', transcripts: '/ws/b.tar.gz', commit: 'a'.repeat(40) }),
    ['check', '--repo', '/ws', '--commit', 'a'.repeat(40), '--transcripts', '/ws/b.tar.gz']
  );
  assert.deepEqual(
    buildCheckArgs({ workspace: '/ws', transcripts: '/ws/b.tar.gz' }),
    ['check', '--repo', '/ws', '--transcripts', '/ws/b.tar.gz']
  );
  assert.deepEqual(
    buildSubmitArgs({
      competition: 'slug-x', repoUrl: 'https://github.com/u/r', commit: 'b'.repeat(40),
      bundlePath: '/ws/b.tar.gz', keypairPath: '/home/u/.makefun/makefun-keypair.json', title: 'Judul',
    }),
    ['submit', '--competition', 'slug-x', '--repo-url', 'https://github.com/u/r',
      '--commit', 'b'.repeat(40), '--bundle', '/ws/b.tar.gz',
      '--keypair', '/home/u/.makefun/makefun-keypair.json', '--title', 'Judul', '--json']
  );
});

/* ------------------------- check output parsing -------------------- */

// Fixture modelled on the kit CLI's real format (Stage 1b proof run:
// every transcript gate passed, thinking_reproduces at 100.0%).
const CHECK_PASS = [
  'check u-contoh-bounty (local kit): /repo at ' + 'a'.repeat(40) + ', received 2026-11-25T16:24:52.000Z, transcripts /tmp/bundle.tar.gz',
  '',
  'pass          competition_open      the competition is open',
  'pass          snapshot              the snapshot matches the repository',
  'pass          license_osi           the license is an OSI license (MIT)',
  'pass          entrypoint            the entrypoint runs',
  'pass          transcripts_present   the transcripts are present',
  'pass          thinking_wellformed   the thinking is well-formed',
  'pass          thinking_reproduces   the transcripts reproduce 100.0% of the authored lines (27/27)',
  'pass          thinking_revised      a file reaches its final content through 2 or more messages',
  'pass          thinking_priced       the usage prices out (7 records)',
  'pass          thinking_turns        7 turns',
  'pass          thinking_own_work     27/27 lines are the session\'s own work',
  'skip          thinking_committed    not committed in this workspace',
  'at submission repo_public           the site checks the repository is public',
  'at submission repo_owner            the site checks the repository owner',
  '',
  '14 passed, 0 failed, 5 skipped, 5 checked at submission',
  'ok: every check run here passes; the rest are the site\'s at submission',
  '',
].join('\n');

const CHECK_FAIL = [
  'check u-contoh-bounty (local kit): /repo at ' + 'a'.repeat(40) + ', received 2026-11-25T16:24:52.000Z, transcripts /tmp/bundle.tar.gz',
  '',
  'pass          competition_open      the competition is open',
  'FAIL          thinking_priced       no usage rows price this session',
  '                              fix: bundle with --muse-usage rows for the session',
  'pass          thinking_reproduces   the transcripts reproduce 86.2% of the authored lines',
  '',
  '13 passed, 1 failed, 5 skipped, 5 checked at submission',
  'not ready: fix thinking_priced, then check again',
  '',
].join('\n');

test('parseCheckOutput parses an all-pass run (Stage 1b style)', () => {
  const r = parseCheckOutput(CHECK_PASS);
  assert.equal(r.passed, 14);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 5);
  assert.equal(r.atSubmission, 5);
  assert.equal(r.ok, true);
  assert.deepEqual(r.failedNames, []);
  const repro = r.checks.find((c) => c.name === 'thinking_reproduces');
  assert.equal(repro.status, 'pass');
  assert.match(repro.reason, /100\.0%/);
  assert.equal(r.checks.find((c) => c.name === 'repo_public').status, 'submission');
  assert.equal(r.checks.find((c) => c.name === 'thinking_committed').status, 'skip');
});

test('parseCheckOutput parses a failing run and names the failed checks', () => {
  const r = parseCheckOutput(CHECK_FAIL);
  assert.equal(r.passed, 13);
  assert.equal(r.failed, 1);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failedNames, ['thinking_priced']);
  const fail = r.checks.find((c) => c.name === 'thinking_priced');
  assert.equal(fail.status, 'fail');
  assert.match(r.verdictLine, /not ready/);
});

test('parseCheckOutput tolerates empty output', () => {
  const r = parseCheckOutput('');
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks, []);
});

test('parseSubmitOutput pulls the submission id and claim code', () => {
  const out = [
    '{',
    '  "submission_id": "01a2107d-b3fd-77b7-8071-5c8f8f49fe61",',
    '  "claim_code": "AF-XXXXX-YYYYY-ZZZZZ-WWWWW"',
    '}',
    'checked: entry 01a2107d-b3fd-77b7-8071-5c8f8f49fe61 passed its checks (stage checked)',
  ].join('\n');
  const r = parseSubmitOutput(out);
  assert.equal(r.submissionId, '01a2107d-b3fd-77b7-8071-5c8f8f49fe61');
  assert.equal(r.claimCode, 'AF-XXXXX-YYYYY-ZZZZZ-WWWWW');
  assert.match(r.checkedLine, /passed its checks/);
  assert.deepEqual(parseSubmitOutput('tidak ada apa-apa'), { submissionId: '', claimCode: '', checkedLine: '' });
});

/* --------------------- integration (skippable) --------------------- */

const PROOF_KIT = path.join(
  os.homedir(), '.makefun',
  'kit-u-deysumbrella-the-3am-fridge-text-4c3e721d',
  'u-deysumbrella-the-3am-fridge-text-4c3e721d-kit'
);
const PROOF_REPO = path.join(os.homedir(), '.makefun', 'electron-proof2-20261125');
const PROOF_SESSION = '/tmp/electron-proof/userdata2/sessions/session-2026-11-25T16-23-33-355Z-515c1c.jsonl';
const proofAvailable = fs.existsSync(path.join(PROOF_KIT, 'cli', 'makefun.mjs'))
  && fs.existsSync(PROOF_REPO)
  && fs.existsSync(PROOF_SESSION);

test('integration: bundle + check the Stage 1b proof session (no submit)',
  { skip: !proofAvailable && 'proof kit/repo/session not present on this machine', timeout: 300000 },
  async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-makefun-it-'));
    const outPath = path.join(outDir, 'bundle.tar.gz');
    const lines = [];
    const bundleRes = await runBundle(
      { workspace: PROOF_REPO, kitDir: PROOF_KIT, sessionFile: PROOF_SESSION, outPath },
      ({ line }) => lines.push(line)
    );
    assert.equal(bundleRes.code, 0, 'bundle exit 0; output tail:\n' + lines.slice(-15).join('\n'));
    assert.equal(bundleRes.vendor, 'google');
    assert.equal(bundleRes.model, 'gemini-3.5-flash');
    assert.ok(fs.existsSync(outPath), 'bundle file written');

    const checkRes = await runCheck(
      { workspace: PROOF_REPO, kitDir: PROOF_KIT, transcripts: outPath },
      () => {}
    );
    // Every transcript gate must pass — that is what Stage 2 wires up.
    // (In the Stage 1b proof these all passed, thinking_reproduces at
    // 100.0%.) The one allowed failure is competition_open: the proof
    // competition's deadline has passed since the proof was recorded,
    // so that check is time-dependent, not pipeline-dependent.
    const transcriptChecks = checkRes.parsed.checks.filter(
      (c) => c.name.startsWith('thinking_') || c.name.startsWith('transcripts_')
    );
    assert.ok(transcriptChecks.length >= 8, 'transcript checks present');
    for (const c of transcriptChecks) {
      assert.ok(c.status === 'pass' || c.status === 'skip',
        c.name + ' should pass or skip, got ' + c.status + ': ' + c.reason);
    }
    const repro = checkRes.parsed.checks.find((c) => c.name === 'thinking_reproduces');
    assert.match(repro.reason, /100\.0%/);
    assert.deepEqual(
      checkRes.parsed.failedNames.filter((n) => n !== 'competition_open'),
      [],
      'no failures beyond the time-dependent competition_open'
    );
    assert.ok(checkRes.parsed.passed >= 13, 'at least 13 checks pass, got ' + checkRes.parsed.passed);
  });

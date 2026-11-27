'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isMutatingTool, normalizePermissions, PermissionGate,
} = require('../src/permissions');
const { runAgentTurn } = require('../src/agent');

test('read-only tools never need approval; mutating tools are classified', () => {
  assert.equal(isMutatingTool('read_file'), false);
  assert.equal(isMutatingTool('list_dir'), false);
  assert.equal(isMutatingTool('write_file'), true);
  assert.equal(isMutatingTool('edit_file'), true);
  assert.equal(isMutatingTool('run_command'), true);
  assert.equal(isMutatingTool('something_else'), false);
});

test('gate: default mode asks for mutating tools only', () => {
  const g = new PermissionGate(undefined);
  assert.equal(g.permissions.mode, 'tanya');
  assert.equal(g.decide('write_file'), 'ask');
  assert.equal(g.decide('run_command'), 'ask');
  assert.equal(g.decide('read_file'), 'allow');
  const free = new PermissionGate({ mode: 'bebas' });
  assert.equal(free.decide('write_file'), 'allow');
  const bad = new PermissionGate({ mode: 'ngawur', alwaysTools: ['read_file', 'write_file', 'write_file'] });
  assert.equal(bad.permissions.mode, 'tanya', 'unknown mode falls back to tanya');
  assert.deepEqual(bad.permissions.alwaysTools, ['write_file'], 'only mutating tools, deduped');
});

test('gate: once/session/always/deny decisions behave', () => {
  const g = new PermissionGate({ mode: 'tanya', alwaysTools: [] });
  assert.deepEqual(g.applyDecision('write_file', 'deny'), { approved: false, persistAlways: false });
  assert.equal(g.decide('write_file'), 'ask', 'deny grants nothing');
  assert.deepEqual(g.applyDecision('write_file', 'once'), { approved: true, persistAlways: false });
  assert.equal(g.decide('write_file'), 'ask', 'once does not carry over');
  assert.deepEqual(g.applyDecision('write_file', 'session'), { approved: true, persistAlways: false });
  assert.equal(g.decide('write_file'), 'allow', 'session grant sticks');
  g.resetSession();
  assert.equal(g.decide('write_file'), 'ask', 'session grant resets with the session');

  const g2 = new PermissionGate({ mode: 'tanya', alwaysTools: [] });
  const r = g2.applyDecision('run_command', 'always');
  assert.deepEqual(r, { approved: true, persistAlways: true });
  g2.resetSession();
  assert.equal(g2.decide('run_command'), 'allow', 'always grant survives session reset');
  assert.deepEqual(normalizePermissions(g2.permissions).alwaysTools, ['run_command']);

  assert.equal(PermissionGate.summarize('run_command', { command: 'npm test' }).includes('npm test'), true);
  assert.equal(PermissionGate.summarize('write_file', { path: 'a.txt', content: ' halo ' }).includes('a.txt'), true);
});

/* ---------------- agent loop integration (fetch stubbed) ------------- */

function stubFetch(responses) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return () => { globalThis.fetch = original; };
}

function completion(message) {
  return { id: 'x', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] };
}

function fakeRunner() {
  const executed = [];
  return {
    executed,
    defs: [],
    execute: async (name, args) => { executed.push({ name, args }); return 'OK ' + name; },
  };
}

test('agent: a DENIED mutating tool never executes and the model is told', async () => {
  const restore = stubFetch([
    completion({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"halo"}' } }] }),
    completion({ role: 'assistant', content: 'Baik, tidak jadi menulis.' }),
  ]);
  try {
    const runner = fakeRunner();
    const events = [];
    const history = [{ role: 'user', content: 'tulis file a.txt' }];
    const asked = [];
    const res = await runAgentTurn({
      providerId: 'gemini', apiKey: 'k', model: 'm', history,
      toolRunner: runner, session: null, workspace: '/tmp/ws', makefunRules: null,
      onEvent: (e) => events.push(e),
      approveTool: async (name) => { asked.push(name); return false; },
    });
    assert.deepEqual(asked, ['write_file']);
    assert.equal(runner.executed.length, 0, 'denied tool must not execute');
    assert.equal(res.finalText, 'Baik, tidak jadi menulis.');
    const toolMsg = history.find((m) => m.role === 'tool');
    assert.ok(toolMsg && toolMsg.content.includes('DITOLAK oleh user'));
    assert.ok(events.some((e) => e.kind === 'tool_denied' && e.name === 'write_file'));
  } finally { restore(); }
});

test('agent: approved mutating tool executes; read-only tools never ask', async () => {
  const restore = stubFetch([
    completion({ role: 'assistant', content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{"path":"b.txt","content":"x"}' } },
    ] }),
    completion({ role: 'assistant', content: 'Selesai.' }),
  ]);
  try {
    const runner = fakeRunner();
    const asked = [];
    const history = [{ role: 'user', content: 'kerja' }];
    await runAgentTurn({
      providerId: 'gemini', apiKey: 'k', model: 'm', history,
      toolRunner: runner, session: null, workspace: '/tmp/ws', makefunRules: null,
      onEvent: () => {},
      approveTool: async (name) => { asked.push(name); return true; },
    });
    assert.deepEqual(asked, ['write_file'], 'only the mutating tool asks');
    assert.deepEqual(runner.executed.map((e) => e.name), ['read_file', 'write_file']);
  } finally { restore(); }
});

test('agent: without approveTool everything runs (back-compat)', async () => {
  const restore = stubFetch([
    completion({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo hi"}' } }] }),
    completion({ role: 'assistant', content: 'ok' }),
  ]);
  try {
    const runner = fakeRunner();
    const history = [{ role: 'user', content: 'jalan' }];
    await runAgentTurn({
      providerId: 'gemini', apiKey: 'k', model: 'm', history,
      toolRunner: runner, session: null, workspace: '/tmp/ws', makefunRules: null,
      onEvent: () => {},
    });
    assert.equal(runner.executed.length, 1);
  } finally { restore(); }
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SessionStore,
  HARNESS_NAME,
  APP_VERSION,
  toolUseBlockFromCall,
  toolCallFromBlock,
  usageFromProvider,
  assistantMessageRecord,
  historyFromEntries,
  uiMessagesFromEntries,
} = require('../src/sessions');
const pkg = require('../package.json');

function tempDirs() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-userdata-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ws-'));
  return { userData, workspace };
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('create writes a session header line to userData and the workspace mirror', () => {
  const { userData, workspace } = tempDirs();
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'gemini', model: 'gemini-3.5-flash' });
  assert.ok(meta.id.startsWith('session-'));
  const mainFile = path.join(userData, 'sessions', meta.id + '.jsonl');
  const mirrorFile = path.join(workspace, '.agent-sessions', meta.id + '.jsonl');
  assert.ok(fs.existsSync(mainFile), 'userData JSONL exists');
  assert.ok(fs.existsSync(mirrorFile), 'workspace mirror exists');
  const first = JSON.parse(fs.readFileSync(mainFile, 'utf8').split('\n')[0]);
  assert.equal(first.type, 'session');
  assert.equal(first.sessionId, meta.id);
  assert.equal(first.cwd, workspace);
  assert.ok(!Number.isNaN(Date.parse(first.timestamp)), 'ISO timestamp parses');
});

test('every recorded line carries version, harness identity and a uuid chain', () => {
  const { userData, workspace } = tempDirs();
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'gemini', model: 'gemini-3.5-flash' });
  store.append(meta, 'system', { message: { role: 'system', content: 'SYS' } });
  store.append(meta, 'user', { message: { role: 'user', content: 'halo' } });

  const lines = readLines(path.join(userData, 'sessions', meta.id + '.jsonl'));
  assert.equal(lines.length, 3);
  assert.equal(APP_VERSION, pkg.version);
  for (const e of lines) {
    assert.equal(e.version, pkg.version, 'version on every line');
    assert.equal(e.harness, HARNESS_NAME);
    assert.equal(e.harness, 'muse-agent-desktop');
    assert.ok(typeof e.uuid === 'string' && e.uuid.length > 0, 'uuid present');
  }
  assert.equal(lines[0].parentUuid, null, 'chain opens with null');
  assert.equal(lines[1].parentUuid, lines[0].uuid, 'chain links line 2 -> line 1');
  assert.equal(lines[2].parentUuid, lines[1].uuid, 'chain links line 3 -> line 2');
});

test('append writes one parseable JSONL line per entry to both files', () => {
  const { userData, workspace } = tempDirs();
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'openai', model: 'gpt-4o' });
  store.append(meta, 'user', { message: { role: 'user', content: 'halo' } });
  store.append(meta, 'assistant', { message: { role: 'assistant', content: 'hai juga' } });
  store.append(meta, 'tool_use', { toolCallId: 'c1', name: 'read_file', args: { path: 'x.txt' } });
  store.append(meta, 'tool_result', { toolCallId: 'c1', name: 'read_file', result: 'isi file', isError: false });

  for (const file of [path.join(userData, 'sessions', meta.id + '.jsonl'), path.join(workspace, '.agent-sessions', meta.id + '.jsonl')]) {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5, file);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((e) => e.type), ['session', 'user', 'assistant', 'tool_use', 'tool_result']);
    for (const e of parsed) {
      assert.equal(e.sessionId, meta.id);
      assert.equal(e.provider, 'openai');
      assert.equal(e.model, 'gpt-4o');
      assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
    }
  }
});

test('usageFromProvider maps OpenAI usage into the recorded shape', () => {
  assert.deepEqual(
    usageFromProvider({ prompt_tokens: 1213, completion_tokens: 647, total_tokens: 1860 }),
    { input_tokens: 1213, output_tokens: 647 }
  );
  assert.deepEqual(
    usageFromProvider({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } }),
    { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80 }
  );
  assert.deepEqual(
    usageFromProvider({ input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 7 }),
    { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 7 }
  );
  assert.equal(usageFromProvider(null), null);
  assert.equal(usageFromProvider({}), null);
});

test('assistantMessageRecord builds claude-style blocks with usage inside the message', () => {
  const ws = '/tmp/ws-proof';
  const msg = {
    content: 'Saya tulis filenya.',
    reasoning_content: 'perlu main.py dulu',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'main.py', content: 'print(1)\n' }) } },
      { id: 'call_2', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'main.py', old_text: 'print(1)', new_text: 'print(2)' }) } },
      { id: 'call_3', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'main.py' }) } },
    ],
  };
  const rec = assistantMessageRecord(msg, {
    model: 'gemini-3.5-flash',
    usage: { prompt_tokens: 1213, completion_tokens: 647 },
    responseId: 'chatcmpl-1',
    finishReason: 'tool_calls',
    workspaceRoot: ws,
  });
  assert.equal(rec.role, 'assistant');
  assert.equal(rec.id, 'chatcmpl-1');
  assert.equal(rec.model, 'gemini-3.5-flash');
  assert.equal(rec.stop_reason, 'tool_use');
  assert.deepEqual(rec.usage, { input_tokens: 1213, output_tokens: 647 });
  assert.deepEqual(rec.content[0], { type: 'thinking', thinking: 'perlu main.py dulu' });
  assert.deepEqual(rec.content[1], { type: 'text', text: 'Saya tulis filenya.' });
  assert.deepEqual(rec.content[2], {
    type: 'tool_use', id: 'call_1', name: 'Write',
    input: { file_path: path.join(ws, 'main.py'), content: 'print(1)\n' },
  });
  assert.deepEqual(rec.content[3], {
    type: 'tool_use', id: 'call_2', name: 'Edit',
    input: { file_path: path.join(ws, 'main.py'), old_string: 'print(1)', new_string: 'print(2)' },
  });
  assert.deepEqual(rec.content[4], {
    type: 'tool_use', id: 'call_3', name: 'Read',
    input: { file_path: path.join(ws, 'main.py') },
  });
});

test('tool blocks round-trip back to app tool calls with relative paths', () => {
  const ws = '/tmp/ws-proof';
  const block = toolUseBlockFromCall(
    { id: 'c9', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a/b.py', old_text: 'x', new_text: 'y' }) } },
    ws
  );
  assert.equal(block.name, 'Edit');
  const back = toolCallFromBlock(block, ws);
  assert.equal(back.id, 'c9');
  assert.equal(back.function.name, 'edit_file');
  // Relative paths come back with the platform separator (\ on Windows).
  assert.deepEqual(JSON.parse(back.function.arguments), { path: path.join('a', 'b.py'), old_text: 'x', new_text: 'y' });
});

test('a recorded v2 session loads back into history and UI messages', () => {
  const { userData, workspace } = tempDirs();
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'gemini', model: 'gemini-3.5-flash' });
  store.append(meta, 'system', { message: { role: 'system', content: 'SYS PROMPT' } });
  store.append(meta, 'user', { message: { role: 'user', content: 'buatkan file halo' } });
  store.append(meta, 'assistant', {
    message: assistantMessageRecord(
      {
        content: 'Siap, kutulis.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'halo.txt', content: 'halo\n' }) } }],
      },
      { model: 'gemini-3.5-flash', usage: { prompt_tokens: 1213, completion_tokens: 647 }, responseId: 'r1', finishReason: 'tool_calls', workspaceRoot: workspace }
    ),
  });
  store.append(meta, 'user', {
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'OK: tertulis 5 byte ke halo.txt' }] },
    toolUseResult: 'OK: tertulis 5 byte ke halo.txt',
  });
  store.append(meta, 'assistant', {
    message: assistantMessageRecord(
      { content: 'Selesai.' },
      { model: 'gemini-3.5-flash', usage: { prompt_tokens: 1500, completion_tokens: 12 }, responseId: 'r2', finishReason: 'stop', workspaceRoot: workspace }
    ),
  });

  const fresh = new SessionStore(userData);
  const entries = fresh.load(meta.id);
  assert.equal(entries.length, 6);

  const history = historyFromEntries(entries, workspace);
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(history[0].content, 'buatkan file halo');
  assert.equal(history[1].content, 'Siap, kutulis.');
  assert.equal(history[1].tool_calls.length, 1);
  assert.equal(history[1].tool_calls[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(history[1].tool_calls[0].function.arguments), { path: 'halo.txt', content: 'halo\n' });
  assert.deepEqual(history[2], { role: 'tool', tool_call_id: 'call_1', content: 'OK: tertulis 5 byte ke halo.txt' });
  assert.equal(history[3].content, 'Selesai.');

  const ui = uiMessagesFromEntries(entries, workspace);
  assert.deepEqual(ui.map((m) => m.type), ['user', 'assistant', 'tool_use', 'tool_result', 'assistant']);
  assert.equal(ui[2].name, 'write_file');
  assert.deepEqual(ui[2].args, { path: 'halo.txt', content: 'halo\n' });
  assert.equal(ui[3].result, 'OK: tertulis 5 byte ke halo.txt');

  const list = fresh.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].preview, 'buatkan file halo');
  assert.equal(list[0].messages, 3, 'system + tool_result lines are not counted as messages');
});

test('historyFromEntries still reads v1 session entries', () => {
  const v1 = [
    { type: 'session', timestamp: '2026-11-25T00:00:00.000Z', meta: { id: 's1', cwd: '/tmp/ws', provider: 'gemini', model: 'm' } },
    { type: 'user', timestamp: '2026-11-25T00:00:01.000Z', message: { role: 'user', content: 'halo' } },
    {
      type: 'assistant', timestamp: '2026-11-25T00:00:02.000Z',
      message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.txt"}' } }] },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    { type: 'tool_use', timestamp: '2026-11-25T00:00:02.500Z', toolCallId: 'c1', name: 'read_file', args: { path: 'x.txt' } },
    { type: 'tool_result', timestamp: '2026-11-25T00:00:03.000Z', toolCallId: 'c1', name: 'read_file', result: 'isi', isError: false },
    { type: 'assistant', timestamp: '2026-11-25T00:00:04.000Z', message: { role: 'assistant', content: 'itu isinya' } },
  ];
  const history = historyFromEntries(v1, '/tmp/ws');
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(history[1].tool_calls[0].function.name, 'read_file');
  assert.deepEqual(history[2], { role: 'tool', tool_call_id: 'c1', content: 'isi' });

  const ui = uiMessagesFromEntries(v1, '/tmp/ws');
  assert.deepEqual(ui.map((m) => m.type), ['user', 'assistant', 'tool_use', 'tool_result', 'assistant']);
});

test('load reads a session back and list summarises it', () => {
  const { userData, workspace } = tempDirs();
  const store = new SessionStore(userData);
  const meta = store.create({ cwd: workspace, provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' });
  store.append(meta, 'user', { message: { role: 'user', content: 'buatkan file halo' } });
  store.append(meta, 'assistant', { message: { role: 'assistant', content: 'selesai' } });

  const fresh = new SessionStore(userData);
  const entries = fresh.load(meta.id);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].message.content, 'buatkan file halo');
  assert.deepEqual(fresh.meta(meta.id), meta);

  const list = fresh.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, meta.id);
  assert.equal(list[0].messages, 2);
  assert.equal(list[0].preview, 'buatkan file halo');
  assert.equal(list[0].provider, 'nvidia');
});

test('load of an unknown id returns an empty array', () => {
  const { userData } = tempDirs();
  const store = new SessionStore(userData);
  assert.deepEqual(store.load('session-tidak-ada'), []);
});

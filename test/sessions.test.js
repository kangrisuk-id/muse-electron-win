'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../src/sessions');

function tempDirs() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-userdata-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ws-'));
  return { userData, workspace };
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

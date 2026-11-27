'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore, assistantMessageRecord } = require('../src/sessions');
const { entryText, searchSessions, sessionToMarkdown } = require('../src/search');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-search-'));
  return new SessionStore(dir);
}

function seedSession(store, { userText, assistantText, toolName, toolArgs, toolResult }) {
  const meta = store.create({ cwd: '/tmp/ws', provider: 'gemini', model: 'm' });
  store.append(meta, 'system', { message: { role: 'system', content: 'SYS prompt rahasia' } });
  store.append(meta, 'user', { message: { role: 'user', content: userText } });
  const msg = { role: 'assistant', content: assistantText || '' };
  if (toolName) {
    msg.tool_calls = [{ id: 'c1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs || {}) } }];
  }
  store.append(meta, 'assistant', {
    message: assistantMessageRecord(msg, { model: 'm', usage: null, workspaceRoot: '/tmp/ws' }),
  });
  if (toolName) {
    store.append(meta, 'user', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: toolResult || '' }] },
      toolUseResult: toolResult || '',
    });
  }
  return meta;
}

test('entryText extracts text from strings, blocks, tool_use and tool_result', () => {
  assert.equal(entryText({ message: { role: 'user', content: 'halo' } }), 'halo');
  const blocks = { message: { role: 'assistant', content: [
    { type: 'text', text: 'jawaban' },
    { type: 'tool_use', name: 'write_file', input: { path: 'a.txt' } },
  ] } };
  const t = entryText(blocks);
  assert.ok(t.includes('jawaban') && t.includes('write_file') && t.includes('a.txt'));
  const res = { message: { role: 'user', content: [{ type: 'tool_result', content: 'isi file penting' }] } };
  assert.equal(entryText(res), 'isi file penting');
  assert.equal(entryText({ type: 'tool_result', result: 'legacy' }), 'legacy');
  assert.equal(entryText({ type: 'session', meta: {} }), '');
  assert.equal(entryText(null), '');
});

test('searchSessions: AND words, case-insensitive, snippets, only matching sessions', () => {
  const store = tmpStore();
  const a = seedSession(store, {
    userText: 'Tolong buatkan laporan keuangan bulan ini',
    assistantText: 'Siap, laporan dibuat.',
    toolName: 'write_file', toolArgs: { path: 'laporan.md' }, toolResult: 'OK tertulis',
  });
  seedSession(store, { userText: 'Halo apa kabar', assistantText: 'Baik!' });

  const hits = searchSessions(store, 'LAPORAN keuangan');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, a.id);
  assert.ok(hits[0].matches.length >= 1);
  assert.ok(hits[0].matches.some((m) => m.snippet.toLowerCase().includes('laporan')));

  // Tool names and results are searchable too.
  assert.equal(searchSessions(store, 'write_file')[0].id, a.id);
  assert.equal(searchSessions(store, 'tertulis')[0].id, a.id);
  // AND semantics: one missing word = no hit.
  assert.deepEqual(searchSessions(store, 'laporan tidakada'), []);
  assert.deepEqual(searchSessions(store, ''), []);
  assert.deepEqual(searchSessions(store, '   '), []);
});

test('sessionToMarkdown renders a readable, honestly truncated export', () => {
  const store = tmpStore();
  const long = 'x'.repeat(5000);
  const meta = seedSession(store, {
    userText: 'buatkan file',
    assistantText: 'baik',
    toolName: 'write_file', toolArgs: { path: 'a.txt', content: 'halo' }, toolResult: long,
  });
  const md = sessionToMarkdown(store.meta(meta.id), store.load(meta.id));
  assert.ok(md.includes('# Sesi Muse Agent Desktop'));
  assert.ok(md.includes('## 🧑 Kamu'));
  assert.ok(md.includes('buatkan file'));
  assert.ok(md.includes('## 🤖 Agent'));
  assert.ok(md.includes('**Tool: `Write (write_file)`**'), 'recorded Claude-style name + app name');
  // file_path is platform-joined by the recorder (backslash on Windows),
  // so assert on the key + filename, never on a literal separator.
  assert.ok(md.includes('"file_path"') && md.includes('a.txt'), 'recorded input shape (file_path absolut)');
  assert.ok(md.includes('…(dipotong untuk ekspor)'), 'long tool result is marked as truncated');
  assert.ok(!md.includes('x'.repeat(3000)), 'long content is actually cut');
  assert.ok(md.includes('## System prompt'));
});

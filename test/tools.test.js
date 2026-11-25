'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolRunner, TOOL_DEFS } = require('../src/tools');

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tools-'));
}

test('exposes exactly the five required tools', () => {
  assert.deepEqual(
    TOOL_DEFS.map((t) => t.function.name),
    ['read_file', 'write_file', 'edit_file', 'list_dir', 'run_command']
  );
});

test('write_file then read_file round-trips, creating parent folders', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  const out = await runner.execute('write_file', { path: 'a/b/hello.txt', content: 'halo dunia' });
  assert.match(out, /OK: tertulis/);
  const read = await runner.execute('read_file', { path: 'a/b/hello.txt' });
  assert.equal(read, 'halo dunia');
  assert.equal(fs.readFileSync(path.join(ws, 'a', 'b', 'hello.txt'), 'utf8'), 'halo dunia');
});

test('edit_file replaces the first exact occurrence', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await runner.execute('write_file', { path: 'x.txt', content: 'satu dua dua' });
  await runner.execute('edit_file', { path: 'x.txt', old_text: 'dua', new_text: 'tiga' });
  const read = await runner.execute('read_file', { path: 'x.txt' });
  assert.equal(read, 'satu tiga dua');
});

test('edit_file fails clearly when old_text is missing', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await runner.execute('write_file', { path: 'x.txt', content: 'abc' });
  await assert.rejects(runner.execute('edit_file', { path: 'x.txt', old_text: 'zzz', new_text: 'y' }), /tidak ditemukan/);
});

test('list_dir lists entries and marks folders', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await runner.execute('write_file', { path: 'sub/f.txt', content: 'x' });
  await runner.execute('write_file', { path: 'top.txt', content: 'y' });
  const listing = await runner.execute('list_dir', {});
  assert.match(listing, /\[dir\]  sub/);
  assert.match(listing, /\[file\] top\.txt/);
});

test('paths escaping the workspace are rejected', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await assert.rejects(runner.execute('read_file', { path: '../outside.txt' }), /di luar workspace/);
  await assert.rejects(runner.execute('write_file', { path: '../../evil.txt', content: 'x' }), /di luar workspace/);
});

test('run_command executes in the workspace and reports the exit code', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  const out = await runner.execute('run_command', { command: 'echo muse-agent-test' });
  assert.match(out, /muse-agent-test/);
  assert.match(out, /\[exit code 0\]/);
});

test('run_command surfaces non-zero exits without throwing', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  const cmd = process.platform === 'win32' ? 'cmd /c exit 3' : 'exit 3';
  const out = await runner.execute('run_command', { command: cmd });
  assert.match(out, /\[exit code 3\]/);
});

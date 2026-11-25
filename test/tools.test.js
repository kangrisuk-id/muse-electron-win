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

/* ------------------------- workspace lock (Stage 3) ------------------------ */

test('lock: inside paths (relative, nested, dotdot-that-stays-in) are allowed', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await runner.execute('write_file', { path: 'a/b/deep.txt', content: 'dalam' });
  assert.equal(await runner.execute('read_file', { path: 'a/b/deep.txt' }), 'dalam');
  // ".." that normalizes back INSIDE the workspace is not an escape.
  assert.equal(await runner.execute('read_file', { path: 'a/../a/b/deep.txt' }), 'dalam');
  assert.equal(runner.resolveInside('a/b/deep.txt'), path.join(ws, 'a', 'b', 'deep.txt'));
});

test('lock: ../ escape is rejected for every file tool', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await assert.rejects(runner.execute('read_file', { path: '../secret.txt' }), /outside the workspace/);
  await assert.rejects(runner.execute('write_file', { path: '../evil.txt', content: 'x' }), /outside the workspace/);
  await assert.rejects(runner.execute('edit_file', { path: '../../x.txt', old_text: 'a', new_text: 'b' }), /outside the workspace/);
  await assert.rejects(runner.execute('list_dir', { path: '..' }), /outside the workspace/);
  assert.throws(() => runner.resolveInside('../x'), /outside the workspace/);
});

test('lock: absolute paths outside the workspace are rejected', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  const outsideAbs = path.join(os.tmpdir(), 'definitely-outside-' + Date.now() + '.txt');
  await assert.rejects(runner.execute('read_file', { path: outsideAbs }), /outside the workspace/);
  await assert.rejects(runner.execute('write_file', { path: outsideAbs, content: 'x' }), /outside the workspace/);
  await assert.rejects(runner.execute('list_dir', { path: os.tmpdir() }), /outside the workspace/);
  // ...while an absolute path INSIDE the workspace still works.
  await runner.execute('write_file', { path: path.join(ws, 'abs-in.txt'), content: 'ok' });
  assert.equal(await runner.execute('read_file', { path: path.join(ws, 'abs-in.txt') }), 'ok');
});

test('lock: symlink escape is rejected (read, write, list)', async (t) => {
  const ws = tempWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tools-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'rahasia', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(ws, 'link-out'), 'junction');
  } catch (err) {
    t.skip('symlink tidak bisa dibuat di mesin ini: ' + err.message);
    return;
  }
  const runner = createToolRunner(ws);
  await assert.rejects(runner.execute('read_file', { path: 'link-out/secret.txt' }), /outside the workspace/);
  await assert.rejects(runner.execute('write_file', { path: 'link-out/pwned.txt', content: 'x' }), /outside the workspace/);
  await assert.rejects(runner.execute('list_dir', { path: 'link-out' }), /outside the workspace/);
  assert.equal(fs.existsSync(path.join(outside, 'pwned.txt')), false);
  // A symlink that stays INSIDE the workspace remains usable.
  fs.mkdirSync(path.join(ws, 'realdir'));
  fs.writeFileSync(path.join(ws, 'realdir', 'in.txt'), 'di dalam', 'utf8');
  try { fs.symlinkSync(path.join(ws, 'realdir'), path.join(ws, 'link-in'), 'junction'); } catch (_) { /* optional */ }
  if (fs.existsSync(path.join(ws, 'link-in'))) {
    assert.equal(await runner.execute('read_file', { path: 'link-in/in.txt' }), 'di dalam');
  }
});

test('lock: run_command cwd outside the workspace is rejected', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await assert.rejects(runner.execute('run_command', { command: 'echo hi', cwd: '..' }), /outside the workspace/);
  await assert.rejects(runner.execute('run_command', { command: 'echo hi', cwd: os.tmpdir() }), /outside the workspace/);
});

test('lock: run_command cwd inside the workspace is honored', async () => {
  const ws = tempWorkspace();
  const runner = createToolRunner(ws);
  await runner.execute('write_file', { path: 'sub/marker.txt', content: 'x' });
  const cmd = process.platform === 'win32' ? 'cd' : 'pwd';
  const out = await runner.execute('run_command', { command: cmd, cwd: 'sub' });
  const expected = fs.realpathSync(path.join(ws, 'sub'));
  assert.ok(out.includes(expected) || out.includes(path.join(ws, 'sub')), 'cwd harus folder sub: ' + out);
});

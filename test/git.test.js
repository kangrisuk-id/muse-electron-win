'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createGit, parseStatusPorcelain, parseLog, parseDiffStat } = require('../src/git');

test('parseStatusPorcelain reads branch, tracking and the three lists', () => {
  const s = parseStatusPorcelain([
    '## main...origin/main [ahead 2, behind 1]',
    'M  staged.txt',
    ' M dirty.txt',
    'MM both.txt',
    '?? baru.txt',
    'R  lama.txt -> baru-nama.txt',
    '',
  ].join('\n'));
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.deepEqual(s.staged.map((x) => x.path), ['staged.txt', 'both.txt', 'baru-nama.txt']);
  assert.deepEqual(s.unstaged.map((x) => x.path), ['dirty.txt', 'both.txt']);
  assert.deepEqual(s.untracked.map((x) => x.path), ['baru.txt']);
  assert.equal(s.clean, false);
});

test('parseStatusPorcelain: clean tree and no-commits branch header', () => {
  const clean = parseStatusPorcelain('## main\n');
  assert.equal(clean.clean, true);
  assert.equal(clean.branch, 'main');
  const fresh = parseStatusPorcelain('## No commits yet on main\n?? a.txt\n');
  assert.equal(fresh.branch, 'main');
  assert.equal(fresh.untracked.length, 1);
});

test('parseLog and parseDiffStat read their CLI shapes', () => {
  const log = parseLog('abc1234\x1fab12\x1fPesan satu\x1f2026-11-25T10:00:00+07:00\x1fKang\n');
  assert.equal(log.length, 1);
  assert.equal(log[0].short, 'ab12');
  assert.equal(log[0].subject, 'Pesan satu');
  const d = parseDiffStat(' src/a.js | 4 ++--\n README.md | 2 ++\n 2 files changed, 4 insertions(+), 2 deletions(-)\n');
  assert.equal(d.files.length, 2);
  assert.equal(d.files[0].changes, 4);
  assert.match(d.total, /2 files changed/);
});

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

test('integration: status → commitAll → clean, log grows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-git-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'halo\n');

  const g = createGit(dir);
  assert.equal(await g.isRepo(), true);
  let info = await g.info();
  assert.equal(info.isRepo, true);
  assert.deepEqual(info.status.untracked.map((x) => x.path), ['a.txt']);

  const res = await g.commitAll('commit pertama');
  assert.match(res.commit, /^[0-9a-f]{40}$/);

  info = await g.info();
  assert.equal(info.status.clean, true);
  assert.equal(info.log.length, 1);
  assert.equal(info.log[0].subject, 'commit pertama');

  await assert.rejects(() => g.commitAll('lagi'), /Tidak ada perubahan/);
  await assert.rejects(() => g.commitAll('   '), /pesan commit/);
});

test('integration: a plain folder is not a repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-nogit-'));
  const g = createGit(dir);
  assert.equal(await g.isRepo(), false);
  const info = await g.info();
  assert.equal(info.isRepo, false);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createBountyProject, DEFAULT_WALLET } = require('../src/wizard');

// Self-contained rules fixture: the real source of truth lives in the
// user's home workspace, which CI runners do not have — depending on it
// made this suite fail on any other machine (GitHub Actions, Windows).
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-wizard-rules-'));
const RULES_SOURCE = path.join(FIXTURE_DIR, '.clinerules');
fs.writeFileSync(RULES_SOURCE, '# Aturan uji wizard\nBaris kedua aturan.\n', 'utf8');

function tempParent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muse-wizard-'));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('wizard creates the full scaffold and one initial git commit', () => {
  const parent = tempParent();
  const res = createBountyProject({
    parentDir: parent,
    folderName: 'makefun-demo-20261125',
    slug: 'u-host-demo-abcdef12',
    wallet: 'WalletPubKey1111111111111111111111111111111',
    rulesSource: RULES_SOURCE,
  });
  const dir = path.join(parent, 'makefun-demo-20261125');
  assert.equal(res.dir, dir);
  assert.equal(res.git.count, 1);
  assert.match(res.git.commit, /^[0-9a-f]{40}$/);

  // Files exist.
  for (const rel of ['LICENSE', 'README.md', '.clinerules', path.join('.makefun', 'owner.json')]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), 'file hilang: ' + rel);
  }
  assert.deepEqual([...res.files].sort(), ['.clinerules', '.makefun/owner.json', 'LICENSE', 'README.md']);

  // owner.json content is exact.
  const owner = JSON.parse(fs.readFileSync(path.join(dir, '.makefun', 'owner.json'), 'utf8'));
  assert.deepEqual(owner, { wallet: 'WalletPubKey1111111111111111111111111111111' });

  // LICENSE carries the SPDX line.
  const license = fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8');
  assert.match(license, /^SPDX-License-Identifier: MIT$/m);
  assert.match(license, /MIT License/);

  // .clinerules is byte-identical to the rules source of truth.
  assert.ok(fs.existsSync(RULES_SOURCE), 'sumber rules harus ada: ' + RULES_SOURCE);
  assert.ok(
    fs.readFileSync(path.join(dir, '.clinerules')).equals(fs.readFileSync(RULES_SOURCE)),
    '.clinerules harus byte-identical dengan sumber'
  );

  // README scaffold: structure present, badges are a marked placeholder
  // comment (never invented URLs).
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /BADGES/);
  assert.match(readme, /<!--[\s\S]*?badge[\s\S]*?-->/i);
  assert.match(readme, /## Sekilas Isi/);
  assert.match(readme, /\| Bagian \| Isi \|/);
  assert.match(readme, /## Galeri/);
  assert.match(readme, /## Metode/);
  assert.match(readme, /u-host-demo-abcdef12/);
  assert.doesNotMatch(readme, /https?:\/\/[^\s)]*badge/i);

  // Git repo: initialized, exactly one commit, clean tree, scaffold tracked.
  assert.equal(git(['rev-list', '--count', 'HEAD'], dir).trim(), '1');
  assert.equal(git(['status', '--porcelain'], dir).trim(), '');
  const tracked = git(['ls-files'], dir).split('\n');
  for (const rel of ['LICENSE', 'README.md', '.clinerules', '.makefun/owner.json']) {
    assert.ok(tracked.includes(rel), 'tidak ter-track git: ' + rel);
  }
});

test('wizard defaults the wallet to the public agent wallet', () => {
  const parent = tempParent();
  const res = createBountyProject({
    parentDir: parent,
    folderName: 'proj-default-wallet',
    rulesSource: RULES_SOURCE,
  });
  assert.equal(res.wallet, DEFAULT_WALLET);
  assert.equal(DEFAULT_WALLET, '6cXDbrdPH6yCbdGoDDFRYw8G2dWV3VQazAc71f6WAaur');
  const owner = JSON.parse(fs.readFileSync(path.join(res.dir, '.makefun', 'owner.json'), 'utf8'));
  assert.deepEqual(owner, { wallet: DEFAULT_WALLET });
});

test('wizard refuses a non-empty existing folder', () => {
  const parent = tempParent();
  const dir = path.join(parent, 'sudah-ada');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'penting.txt'), 'jangan ditimpa', 'utf8');
  assert.throws(
    () => createBountyProject({ parentDir: parent, folderName: 'sudah-ada', rulesSource: RULES_SOURCE }),
    /sudah ada dan tidak kosong/
  );
  // The existing content is untouched.
  assert.equal(fs.readFileSync(path.join(dir, 'penting.txt'), 'utf8'), 'jangan ditimpa');
});

test('wizard accepts an existing EMPTY folder', () => {
  const parent = tempParent();
  fs.mkdirSync(path.join(parent, 'kosong'));
  const res = createBountyProject({ parentDir: parent, folderName: 'kosong', rulesSource: RULES_SOURCE });
  assert.equal(res.git.count, 1);
  assert.ok(fs.existsSync(path.join(res.dir, 'README.md')));
});

test('wizard with a missing rules source warns and skips only .clinerules', () => {
  const parent = tempParent();
  const res = createBountyProject({
    parentDir: parent,
    folderName: 'tanpa-rules',
    rulesSource: path.join(parent, 'tidak-ada', '.clinerules'),
  });
  assert.equal(fs.existsSync(path.join(res.dir, '.clinerules')), false);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /rules tidak ditemukan/i);
  assert.ok(fs.existsSync(path.join(res.dir, 'LICENSE')));
  assert.ok(fs.existsSync(path.join(res.dir, 'README.md')));
  assert.equal(res.git.count, 1);
});

test('wizard rejects a missing parent dir and path-like folder names', () => {
  const parent = tempParent();
  assert.throws(
    () => createBountyProject({ parentDir: path.join(parent, 'tidak-ada'), folderName: 'x', rulesSource: RULES_SOURCE }),
    /Folder induk tidak ditemukan/
  );
  assert.throws(
    () => createBountyProject({ parentDir: parent, folderName: '../escape', rulesSource: RULES_SOURCE }),
    /tidak valid/
  );
  assert.throws(
    () => createBountyProject({ parentDir: parent, folderName: 'a/b', rulesSource: RULES_SOURCE }),
    /tidak valid/
  );
});

'use strict';

/**
 * "Bounty Baru" wizard — scaffolds a new make.fun bounty project folder.
 *
 * The user's discipline is one folder = one bounty = one session. Creating
 * a project lays down everything an entry repo needs before any building
 * starts, so the recorded session can go straight to work:
 *
 *   <folder>/
 *     .clinerules          (copied byte-for-byte from the rules source)
 *     LICENSE              (MIT, with the SPDX-License-Identifier line)
 *     README.md            (visual-standard SCAFFOLD — placeholders only)
 *     .makefun/owner.json  ({"wallet": "<agent wallet>"} — server-checked)
 *     .git/                (initialized, one initial commit)
 *
 * Pure Node (fs/path/child_process) so it is unit-testable without
 * Electron. The README scaffold deliberately contains NO invented
 * content: the 3 live badge SVGs are competition-specific and come from
 * the kit requirements at build time, so the scaffold marks them as a
 * placeholder comment instead of fabricating URLs.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_WALLET = '6cXDbrdPH6yCbdGoDDFRYw8G2dWV3VQazAc71f6WAaur';
const FALLBACK_GIT_NAME = 'kangrisuk-id';
const FALLBACK_GIT_EMAIL = 'kangrisuk-id@users.noreply.github.com';

const LICENSE_TEXT = [
  'MIT License',
  '',
  'SPDX-License-Identifier: MIT',
  '',
  'Copyright (c) 2026 kangrisuk-id',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
  '',
].join('\n');

function readmeScaffold({ folderName, slug }) {
  const lines = [
    '# <JUDUL ENTRY — tulis judul sesuai lembar spesifikasi submission>',
    '',
    '<!--',
    '  BADGES: TEMPATKAN 3 BADGE SVG LIVE make.fun DI SINI, byte-exact.',
    '  Badge bersifat spesifik per kompetisi dan diambil dari requirements',
    '  kit kompetisi (how_to_submit.readme_template) pada saat build —',
    '  JANGAN mengarang URL badge. Scaffold ini sengaja TIDAK berisi badge.',
    slug ? '  Kompetisi: ' + slug : '  Kompetisi: (slug belum diisi)',
    '-->',
    '',
    '<!-- HERO IMAGE: ganti baris di bawah dengan gambar hero final entry ini. -->',
    '<!-- ![hero](hero.png) -->',
    '',
    '## Sekilas Isi',
    '',
    '| Bagian | Isi |',
    '| --- | --- |',
    '| Entry | _(apa yang dikirim — satu baris)_ |',
    '| Metode | _(metode dalam satu baris; detail di bagian Metode)_ |',
    '| Hasil | _(angka hasil akhir — isi setelah entry jadi)_ |',
    '',
    '## Galeri',
    '',
    '<!-- GALERI SCREENSHOT BERKETERANGAN: satu blok per gambar, caption wajib. -->',
    '<!--',
    '![caption gambar 1](screenshot-1.png)',
    '*Caption gambar 1 — apa yang ditunjukkan gambar ini.*',
    '-->',
    '',
    '## Metode',
    '',
    '_(Tulis metode entry di sini: bagaimana kandidat/varian dihasilkan,',
    'bagaimana pemenang dipilih, dan bagaimana hasil diverifikasi.',
    'Untuk bounty yang dinilai juri: jumlah kandidat, kriteria + urutannya,',
    'dan hasil turnamen knockout. Untuk bounty objektif: algoritma,',
    'baseline pembanding, dan margin terukur.)_',
    '',
    '## Cara Menjalankan',
    '',
    '_(Perintah menjalankan entry, persis seperti yang dijalankan grader.)_',
    '',
    '## Lisensi',
    '',
    'MIT — lihat [LICENSE](LICENSE).',
    '',
  ];
  return lines.join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', shell: false });
}

function gitIdentityAvailable(dir) {
  try {
    git(['config', 'user.name'], dir);
    git(['config', 'user.email'], dir);
    return true;
  } catch (_) {
    return false;
  }
}

function initGitRepo(dir) {
  git(['init', '-q'], dir);
  if (!gitIdentityAvailable(dir)) {
    git(['config', 'user.name', FALLBACK_GIT_NAME], dir);
    git(['config', 'user.email', FALLBACK_GIT_EMAIL], dir);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'Bounty Baru: scaffold awal (wizard)'], dir);
  const commit = git(['rev-parse', 'HEAD'], dir).trim();
  const count = parseInt(git(['rev-list', '--count', 'HEAD'], dir).trim(), 10);
  return { commit, count };
}

/**
 * Create a new bounty project.
 *
 * @param {object} opts
 * @param {string} opts.parentDir   Existing directory the project goes in.
 * @param {string} opts.folderName  New folder name (single path segment).
 * @param {string} [opts.slug]      Competition slug (optional at creation).
 * @param {string} [opts.wallet]    Agent wallet for .makefun/owner.json.
 * @param {string} [opts.rulesSource] Path to the .clinerules source file.
 * @returns {{dir: string, files: string[], warnings: string[], slug: string,
 *            wallet: string, git: {commit: string, count: number}}}
 * Throws (with an Indonesian, user-readable message) on refusal: parent
 * missing, invalid folder name, or target exists and is non-empty.
 */
function createBountyProject(opts) {
  const parentDir = opts && opts.parentDir;
  const folderName = opts && opts.folderName;
  const slug = (opts && opts.slug ? String(opts.slug) : '').trim();
  const wallet = (opts && opts.wallet ? String(opts.wallet) : '').trim() || DEFAULT_WALLET;
  const rulesSource = opts && opts.rulesSource;

  if (!parentDir || !fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
    throw new Error('Folder induk tidak ditemukan: ' + parentDir);
  }
  if (
    !folderName ||
    folderName !== path.basename(folderName) ||
    folderName === '.' ||
    folderName === '..' ||
    /[<>:"/\\|?*\x00-\x1f]/.test(folderName)
  ) {
    throw new Error('Nama folder proyek tidak valid: ' + folderName);
  }

  const dir = path.join(path.resolve(parentDir), folderName);
  if (fs.existsSync(dir)) {
    const existing = fs.readdirSync(dir);
    if (existing.length > 0) {
      throw new Error(
        'Folder sudah ada dan tidak kosong — wizard menolak menimpa: ' + dir +
        ' (' + existing.length + ' item). Pilih nama folder lain.'
      );
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  const files = [];
  const warnings = [];

  // .clinerules — copied byte-for-byte; a missing source skips ONLY this
  // file and is surfaced as a warning, everything else still succeeds.
  if (rulesSource && fs.existsSync(rulesSource)) {
    fs.copyFileSync(rulesSource, path.join(dir, '.clinerules'));
    files.push('.clinerules');
  } else {
    warnings.push(
      'File rules tidak ditemukan di ' + (rulesSource || '(tidak ada sumber)') +
      ' — .clinerules TIDAK dibuat. Salin manual sebelum mulai sesi.'
    );
  }

  fs.writeFileSync(path.join(dir, 'LICENSE'), LICENSE_TEXT, 'utf8');
  files.push('LICENSE');

  fs.mkdirSync(path.join(dir, '.makefun'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.makefun', 'owner.json'),
    JSON.stringify({ wallet }, null, 2) + '\n',
    'utf8'
  );
  files.push('.makefun/owner.json');

  fs.writeFileSync(path.join(dir, 'README.md'), readmeScaffold({ folderName, slug }), 'utf8');
  files.push('README.md');

  const gitInfo = initGitRepo(dir);

  return { dir, files, warnings, slug, wallet, git: gitInfo };
}

module.exports = {
  createBountyProject,
  readmeScaffold,
  LICENSE_TEXT,
  DEFAULT_WALLET,
  FALLBACK_GIT_NAME,
  FALLBACK_GIT_EMAIL,
};

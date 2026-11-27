'use strict';

/**
 * Stage 5a — built-in git for the active workspace.
 *
 * Read side is pure parsing over `git` CLI output (status porcelain,
 * log, diff --stat); the write side is deliberately narrow: `git add -A`
 * + one commit with the user's own message, always inside the workspace
 * cwd. No push, no branch surgery, no history rewriting — pushing stays
 * a deliberate act outside the app, exactly like make.fun submit keeps
 * its two-step confirm.
 *
 * Every command runs with cwd = workspace; callers in main.js pass the
 * settings workspace, never a renderer-supplied path.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const GIT_TIMEOUT_MS = 30000;

function defaultRunner(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr || err.message || 'git gagal').trim());
          e.code = err.code;
          e.stdout = stdout || '';
          reject(e);
          return;
        }
        resolve(stdout || '');
      });
  });
}

/* --------------------------- pure parsers --------------------------- */

/**
 * Parse `git status --porcelain=v1 -b`.
 * Returns {branch, upstream, ahead, behind, staged, unstaged, untracked,
 * clean} where the three lists hold {code, path} entries.
 */
function parseStatusPorcelain(text) {
  const out = {
    branch: '', upstream: '', ahead: 0, behind: 0,
    staged: [], unstaged: [], untracked: [], clean: true,
  };
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3).trim();
      const [branchPart, trackPart] = head.split('...');
      out.branch = branchPart === 'No commits yet on' ? '' : branchPart.trim();
      // "No commits yet on main" form
      if (head.startsWith('No commits yet on ')) out.branch = head.slice('No commits yet on '.length).trim();
      if (trackPart) {
        const m = trackPart.trim().match(/^(\S+)(?:\s+\[ahead (\d+)(?:, behind (\d+))?\]|\s+\[behind (\d+)\])?/);
        if (m) {
          out.upstream = m[1];
          out.ahead = Number(m[2] || 0);
          out.behind = Number(m[3] || m[4] || 0);
        }
      }
      continue;
    }
    const code = line.slice(0, 2);
    let filePath = line.slice(3);
    const arrow = filePath.indexOf(' -> ');
    if (arrow >= 0) filePath = filePath.slice(arrow + 4);
    if (code === '??') {
      out.untracked.push({ code, path: filePath });
    } else {
      if (code[0] !== ' ') out.staged.push({ code: code[0], path: filePath });
      if (code[1] !== ' ') out.unstaged.push({ code: code[1], path: filePath });
    }
  }
  out.clean = !out.staged.length && !out.unstaged.length && !out.untracked.length;
  return out;
}

const LOG_SEP = '\x1f';

/** Parse `git log --format=%H%x1f%h%x1f%s%x1f%aI%x1f%an`. */
function parseLog(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [hash, short, subject, date, author] = line.split(LOG_SEP);
    rows.push({ hash: hash || '', short: short || '', subject: subject || '', date: date || '', author: author || '' });
  }
  return rows;
}

/** Parse `git diff --stat` (and --cached) into {files:[{path,changes}], total}. */
function parseDiffStat(text) {
  const files = [];
  let total = '';
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const summary = line.match(/^\s*\d+ files? changed/);
    if (summary) { total = line.trim(); continue; }
    const m = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)\s*$/);
    if (m) files.push({ path: m[1].trim(), changes: Number(m[2]), marks: m[3] });
    else if (line.includes('|')) {
      const [p, rest] = line.split('|');
      const n = parseInt(rest, 10);
      files.push({ path: p.trim(), changes: Number.isNaN(n) ? 0 : n, marks: '' });
    }
  }
  return { files, total };
}

/* --------------------------- async wrappers -------------------------- */

function createGit(workspace, runner) {
  const run = runner || defaultRunner;
  if (!workspace) throw new Error('workspace belum dipilih');
  const cwd = path.resolve(workspace);

  async function isRepo() {
    try {
      const out = await run(['rev-parse', '--is-inside-work-tree'], cwd);
      return out.trim() === 'true';
    } catch (_) {
      return false;
    }
  }

  async function info() {
    if (!fs.existsSync(cwd)) return { isRepo: false, workspace: cwd };
    if (!(await isRepo())) return { isRepo: false, workspace: cwd };
    const [statusText, logText, diffText, cachedText] = await Promise.all([
      run(['status', '--porcelain=v1', '-b'], cwd),
      run(['log', '-20', '--format=%H%x1f%h%x1f%s%x1f%aI%x1f%an'], cwd).catch(() => ''),
      run(['diff', '--stat'], cwd).catch(() => ''),
      run(['diff', '--cached', '--stat'], cwd).catch(() => ''),
    ]);
    return {
      isRepo: true,
      workspace: cwd,
      status: parseStatusPorcelain(statusText),
      log: parseLog(logText),
      diff: parseDiffStat(diffText),
      diffCached: parseDiffStat(cachedText),
    };
  }

  /**
   * Stage everything and commit with the user's message. Returns
   * {commit, subject}. Refuses empty messages and a clean tree.
   */
  async function commitAll(message) {
    const msg = String(message || '').trim();
    if (!msg) throw new Error('Isi pesan commit dulu.');
    if (!(await isRepo())) throw new Error('Workspace ini bukan repo git.');
    const status = parseStatusPorcelain(await run(['status', '--porcelain=v1', '-b'], cwd));
    if (status.clean) throw new Error('Tidak ada perubahan untuk di-commit.');
    await run(['add', '-A'], cwd);
    await run(['commit', '-m', msg], cwd);
    const commit = (await run(['rev-parse', 'HEAD'], cwd)).trim();
    return { commit, subject: msg };
  }

  return { isRepo, info, commitAll, workspace: cwd };
}

module.exports = {
  createGit,
  parseStatusPorcelain,
  parseLog,
  parseDiffStat,
  LOG_SEP,
};

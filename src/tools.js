'use strict';

/**
 * Agent tools, strictly scoped to a chosen workspace folder.
 *
 * WORKSPACE LOCK (hard, no bypass): every file tool resolves its target
 * path — absolute, normalized, and symlink-resolved for the deepest
 * existing ancestor — and REJECTS anything that lands outside the
 * workspace root. "..", absolute paths, and symlinks pointing out are
 * all refused with a clear error. run_command executes with cwd =
 * workspace root; a requested cwd is validated by the same lock.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const MAX_READ_CHARS = 100000;
const MAX_OUTPUT_CHARS = 8000;
const COMMAND_TIMEOUT_MS = 60000;

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside the workspace. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative file path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (create or fully overwrite) a text file inside the workspace. Parent folders are created. Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace the first exact occurrence of old_text with new_text in a workspace file. Fails if old_text is not found.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          old_text: { type: 'string', description: 'Exact text to find' },
          new_text: { type: 'string', description: 'Replacement text (may be empty)' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders inside a workspace directory (default: workspace root). Path is relative to the workspace root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative directory path (optional)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command with the workspace as working directory. An optional cwd (relative to the workspace, or absolute) must stay inside the workspace — anything outside is rejected. 60 second timeout; output is truncated.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd: { type: 'string', description: 'Working directory inside the workspace (optional; default: workspace root)' },
        },
        required: ['command'],
      },
    },
  },
];

function truncate(text, max) {
  if (typeof text !== 'string') text = String(text == null ? '' : text);
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n…[dipotong, total ' + text.length + ' karakter]';
}

function outsideError(rel) {
  return new Error(
    'Path is outside the workspace (di luar workspace ditolak): ' + rel +
    '. The workspace lock has no bypass — use a path inside the workspace.'
  );
}

function isInside(candidate, base) {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * Realpath of the deepest existing ancestor of `abs`, plus the remaining
 * (not yet existing) tail segments. This is what defeats symlink escapes:
 * a path that lexically sits inside the workspace but resolves — through
 * a symlinked directory — to somewhere outside is caught here.
 */
function realpathDeepest(abs) {
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      return { real: fs.realpathSync(cur), tail };
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) return { real: null, tail };
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function createToolRunner(workspaceRoot) {
  if (!workspaceRoot) throw new Error('workspaceRoot is required');
  const root = path.resolve(workspaceRoot);
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch (_) { /* root may not exist yet */ }

  function resolveInside(rel) {
    // 1) Lexical check: normalize + resolve, refuse ".." / absolute escapes.
    const abs = path.resolve(root, rel || '.');
    if (!isInside(abs, root)) throw outsideError(rel);
    // 2) Symlink check: resolve the deepest existing ancestor for real and
    //    refuse when the true location leaves the workspace.
    const { real, tail } = realpathDeepest(abs);
    if (real !== null) {
      const candidate = tail.length ? path.join(real, ...tail) : real;
      if (!isInside(candidate, realRoot)) throw outsideError(rel);
    }
    return abs;
  }

  async function execute(name, args) {
    args = args || {};
    switch (name) {
      case 'read_file': {
        const abs = resolveInside(args.path);
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error('Bukan file: ' + args.path);
        const content = fs.readFileSync(abs, 'utf8');
        return truncate(content, MAX_READ_CHARS);
      }
      case 'write_file': {
        const abs = resolveInside(args.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content == null ? '' : args.content), 'utf8');
        return 'OK: tertulis ' + Buffer.byteLength(String(args.content || ''), 'utf8') + ' byte ke ' + args.path;
      }
      case 'edit_file': {
        const abs = resolveInside(args.path);
        const before = fs.readFileSync(abs, 'utf8');
        const idx = before.indexOf(args.old_text);
        if (idx === -1) throw new Error('old_text tidak ditemukan di ' + args.path);
        const after = before.slice(0, idx) + args.new_text + before.slice(idx + args.old_text.length);
        fs.writeFileSync(abs, after, 'utf8');
        return 'OK: ' + args.path + ' diubah (' + before.length + ' → ' + after.length + ' karakter)';
      }
      case 'list_dir': {
        const abs = resolveInside(args.path || '.');
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const lines = entries.slice(0, 300).map((e) => (e.isDirectory() ? '[dir]  ' : '[file] ') + e.name);
        return lines.length ? lines.join('\n') : '(folder kosong)';
      }
      case 'run_command': {
        // cwd defaults to the workspace root; a requested cwd (relative or
        // absolute) must pass the same workspace lock as the file tools.
        const cwdAbs = args.cwd ? resolveInside(args.cwd) : root;
        return await new Promise((resolve) => {
          exec(
            String(args.command || ''),
            { cwd: cwdAbs, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              const out = [];
              if (stdout) out.push(stdout);
              if (stderr) out.push('[stderr]\n' + stderr);
              let code = 0;
              if (err) {
                code = typeof err.code === 'number' ? err.code : 1;
                if (err.killed) out.push('[perintah dihentikan: timeout 60 detik]');
              }
              out.push('[exit code ' + code + ']');
              resolve(truncate(out.join('\n'), MAX_OUTPUT_CHARS));
            }
          );
        });
      }
      default:
        throw new Error('Tool tidak dikenal: ' + name);
    }
  }

  return { defs: TOOL_DEFS, execute, root, resolveInside };
}

module.exports = { TOOL_DEFS, createToolRunner, truncate, MAX_OUTPUT_CHARS, COMMAND_TIMEOUT_MS };

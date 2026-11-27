'use strict';

/**
 * Stage 7 — tool permission gate.
 *
 * Read-only tools (read_file, list_dir) NEVER need approval. Mutating
 * tools (write_file, edit_file, run_command) are gated by the user's
 * chosen mode, stored in settings.permissions:
 *
 *   mode 'tanya' (default): ask before every mutating call.
 *   mode 'bebas':            never ask (the pre-Stage-7 behaviour).
 *
 * Two grant layers can silence the asking without changing the mode:
 *   - alwaysTools (persisted in settings): tools the user marked
 *     "selalu izinkan" — auto-approved in every session.
 *   - session grants (in memory only): tools approved "untuk sesi
 *     ini" — auto-approved until the session changes or the app exits.
 *
 * The gate is pure decision logic; the actual asking (IPC + UI) lives
 * in main.js/renderer. A denied call never executes: the agent loop
 * records a clear tool result so the model can adapt or stop.
 */

const READ_ONLY_TOOLS = ['read_file', 'list_dir'];
const MUTATING_TOOLS = ['write_file', 'edit_file', 'run_command'];
const MODES = ['tanya', 'bebas'];
const DECISIONS = ['once', 'session', 'always', 'deny'];

function isMutatingTool(name) {
  return MUTATING_TOOLS.includes(name);
}

function normalizePermissions(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MODES.includes(p.mode) ? p.mode : 'tanya',
    alwaysTools: Array.isArray(p.alwaysTools)
      ? [...new Set(p.alwaysTools.filter((t) => MUTATING_TOOLS.includes(t)))]
      : [],
  };
}

class PermissionGate {
  /**
   * @param {object} permissions settings.permissions (normalized here)
   */
  constructor(permissions) {
    this.permissions = normalizePermissions(permissions);
    this.sessionGrants = new Set();
  }

  setPermissions(permissions) {
    this.permissions = normalizePermissions(permissions);
  }

  /** Start a fresh session: session grants never leak across sessions. */
  resetSession() {
    this.sessionGrants.clear();
  }

  /** 'allow' | 'ask' for this tool right now. */
  decide(toolName) {
    if (!isMutatingTool(toolName)) return 'allow';
    if (this.permissions.mode === 'bebas') return 'allow';
    if (this.permissions.alwaysTools.includes(toolName)) return 'allow';
    if (this.sessionGrants.has(toolName)) return 'allow';
    return 'ask';
  }

  /**
   * Apply the user's answer to an approval prompt.
   * Returns {approved: boolean, persistAlways: boolean} — the caller
   * persists 'always' grants into settings.
   */
  applyDecision(toolName, decision) {
    if (!DECISIONS.includes(decision)) return { approved: false, persistAlways: false };
    if (decision === 'deny') return { approved: false, persistAlways: false };
    if (decision === 'session') this.sessionGrants.add(toolName);
    if (decision === 'always') {
      this.sessionGrants.add(toolName);
      if (!this.permissions.alwaysTools.includes(toolName)) {
        this.permissions.alwaysTools.push(toolName);
      }
      return { approved: true, persistAlways: true };
    }
    return { approved: true, persistAlways: false };
  }

  /** Short human summary of a tool call for the approval card. */
  static summarize(toolName, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (toolName === 'write_file') {
      const len = typeof a.content === 'string' ? a.content.length : 0;
      return `Menulis file ${a.path || '?'} (${len} karakter, menimpa bila sudah ada)`;
    }
    if (toolName === 'edit_file') return `Mengedit file ${a.path || '?'}`;
    if (toolName === 'run_command') return `Menjalankan perintah: ${String(a.command || '').slice(0, 300)}`;
    return `Memanggil tool ${toolName}`;
  }
}

module.exports = {
  READ_ONLY_TOOLS, MUTATING_TOOLS, MODES, DECISIONS,
  isMutatingTool, normalizePermissions, PermissionGate,
};

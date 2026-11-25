'use strict';

/**
 * Session recording as JSONL.
 *
 * Every session is appended line-by-line (one JSON object per line) to:
 *   <userData>/sessions/<id>.jsonl          (app-owned store)
 *   <workspace>/.agent-sessions/<id>.jsonl  (mirror next to the work)
 *
 * Entry shape loosely follows the Claude Code JSONL style: each line has a
 * `type`, an ISO `timestamp`, `sessionId`, `cwd`, and a `message` payload
 * for conversational entries. EXPERIMENTAL: this format has not yet been
 * proven against make.fun server checks (see README roadmap).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function newSessionId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return 'session-' + stamp + '-' + crypto.randomBytes(3).toString('hex');
}

class SessionStore {
  constructor(userDataDir) {
    if (!userDataDir) throw new Error('userDataDir is required');
    this.dir = path.join(userDataDir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = new Map(); // id -> meta
  }

  fileFor(id) {
    return path.join(this.dir, id + '.jsonl');
  }

  mirrorFileFor(meta) {
    if (!meta || !meta.cwd) return null;
    return path.join(meta.cwd, '.agent-sessions', meta.id + '.jsonl');
  }

  create({ cwd, provider, model }) {
    const meta = {
      id: newSessionId(),
      createdAt: new Date().toISOString(),
      cwd: cwd || '',
      provider: provider || '',
      model: model || '',
    };
    this.sessions.set(meta.id, meta);
    this.append(meta, 'session', { meta });
    return meta;
  }

  /** Append one entry. `type`: session|system|user|assistant|tool_use|tool_result */
  append(meta, type, data) {
    const entry = {
      type,
      timestamp: new Date().toISOString(),
      sessionId: meta.id,
      cwd: meta.cwd,
      provider: meta.provider,
      model: meta.model,
      ...(data || {}),
    };
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.fileFor(meta.id), line, 'utf8');
    const mirror = this.mirrorFileFor(meta);
    if (mirror) {
      try {
        fs.mkdirSync(path.dirname(mirror), { recursive: true });
        fs.appendFileSync(mirror, line, 'utf8');
      } catch (_) {
        /* mirror is best-effort; the userData copy is authoritative */
      }
    }
    return entry;
  }

  /** Read and parse all entries of a session (from the userData store). */
  load(id) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const entries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch (_) { /* skip torn line */ }
    }
    const first = entries.find((e) => e.type === 'session');
    if (first && first.meta) this.sessions.set(id, first.meta);
    return entries;
  }

  meta(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const entries = this.load(id);
    const first = entries.find((e) => e.type === 'session');
    return first ? first.meta : null;
  }

  /** List known sessions, newest first. */
  list() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      let entries = [];
      try { entries = this.load(id); } catch (_) { continue; }
      const head = entries.find((e) => e.type === 'session');
      const firstUser = entries.find((e) => e.type === 'user');
      out.push({
        id,
        createdAt: head ? head.timestamp : '',
        cwd: head && head.meta ? head.meta.cwd : '',
        provider: head && head.meta ? head.meta.provider : '',
        model: head && head.meta ? head.meta.model : '',
        messages: entries.filter((e) => e.type === 'user' || e.type === 'assistant').length,
        preview: firstUser && firstUser.message && typeof firstUser.message.content === 'string'
          ? firstUser.message.content.slice(0, 80)
          : '',
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }
}

module.exports = { SessionStore, newSessionId };

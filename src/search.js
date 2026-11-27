'use strict';

/**
 * Stage 10 — session search & Markdown export.
 *
 * Search runs over the recorded JSONL entries of every session in a
 * SessionStore. A query is one or more words; a session entry matches
 * when ALL words appear (case-insensitive) in its searchable text
 * (message text blocks, tool names + inputs, tool results). Results
 * carry a short snippet around the first matched word.
 *
 * Export renders one session as readable Markdown: header metadata,
 * then Kamu/Agent turns, tool calls and (truncated) tool results.
 * Truncation is always marked — an export never silently drops text.
 */

const { APP_TOOL_NAMES } = require('./sessions');

const SNIPPET_PAD = 60;
const MAX_MATCHES_PER_SESSION = 5;
const MAX_SESSIONS = 25;
const EXPORT_TOOL_RESULT_LIMIT = 2000;
const EXPORT_TOOL_INPUT_LIMIT = 1000;

/** Searchable plain text of one recorded entry ('' when none). */
function entryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  // Legacy/alternate line shapes: bare tool_use / tool_result entries.
  if (entry.type === 'tool_use') {
    let s = String(entry.name || '');
    try { s += '\n' + JSON.stringify(entry.args || {}); } catch (_) { /* ignore */ }
    return s;
  }
  if (entry.type === 'tool_result') {
    return typeof entry.result === 'string' ? entry.result : '';
  }
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  const parts = [];
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
    else if (block.type === 'tool_use') {
      // Recorded blocks carry Claude-style names (Write/Read/Bash);
      // index BOTH that name and the app tool name (write_file/…)
      // so searching either finds the call.
      parts.push(String(block.name || ''));
      const appName = APP_TOOL_NAMES[block.name];
      if (appName && appName !== block.name) parts.push(appName);
      try { parts.push(JSON.stringify(block.input || {})); } catch (_) { /* ignore */ }
    } else if (block.type === 'tool_result') {
      if (typeof block.content === 'string') parts.push(block.content);
      else if (Array.isArray(block.content)) {
        for (const c of block.content) {
          if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        }
      }
    }
  }
  return parts.join('\n');
}

function entryRole(entry) {
  const msg = entry && entry.message;
  if (msg && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')) return msg.role;
  return entry && entry.type ? String(entry.type) : 'entry';
}

function makeSnippet(text, firstWord) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(firstWord);
  if (at < 0) return text.slice(0, SNIPPET_PAD * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(text.length, at + firstWord.length + SNIPPET_PAD);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  return s;
}

/**
 * Search all sessions in a store.
 * @param {object} store SessionStore (list() + load(id) + meta(id))
 * @param {string} query words, ALL must appear per entry
 * @returns {Array<{id, createdAt, provider, model, cwd, matches: Array<{role, snippet}>}>}
 */
function searchSessions(store, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !store) return [];
  const results = [];
  for (const item of store.list()) {
    if (results.length >= MAX_SESSIONS) break;
    const entries = store.load(item.id);
    const matches = [];
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES_PER_SESSION) break;
      const text = entryText(entry);
      if (!text) continue;
      const lower = text.toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        matches.push({ role: entryRole(entry), snippet: makeSnippet(text, words[0]) });
      }
    }
    if (matches.length > 0) {
      results.push({
        id: item.id,
        createdAt: item.createdAt || '',
        provider: item.provider || '',
        model: item.model || '',
        cwd: item.cwd || '',
        matches,
      });
    }
  }
  return results;
}

function truncate(text, limit) {
  const s = String(text == null ? '' : text);
  if (s.length <= limit) return { text: s, truncated: false };
  return { text: s.slice(0, limit), truncated: true };
}

/** Render one session (meta + recorded entries) as Markdown. */
function sessionToMarkdown(meta, entries) {
  const m = meta || {};
  const lines = [];
  lines.push('# Sesi Muse Agent Desktop');
  lines.push('');
  lines.push('- ID: `' + (m.id || '?') + '`');
  if (m.createdAt) lines.push('- Mulai: ' + m.createdAt);
  if (m.provider || m.model) lines.push('- Provider/Model: ' + [m.provider, m.model].filter(Boolean).join(' / '));
  if (m.cwd) lines.push('- Workspace: `' + m.cwd + '`');
  lines.push('');
  for (const entry of entries || []) {
    if (entry && entry.type === 'tool_use') {
      const input = truncate(JSON.stringify(entry.args || {}, null, 2), EXPORT_TOOL_INPUT_LIMIT);
      lines.push('## 🤖 Agent');
      lines.push('');
      lines.push('**Tool: `' + (entry.name || '?') + '`**');
      lines.push('');
      lines.push('```json');
      lines.push(input.text + (input.truncated ? '\n…(dipotong untuk ekspor)' : ''));
      lines.push('```');
      lines.push('');
      continue;
    }
    if (entry && entry.type === 'tool_result') {
      const t = truncate(entry.result || '', EXPORT_TOOL_RESULT_LIMIT);
      lines.push('**Hasil tool' + (entry.isError ? ' (error)' : '') + ':**');
      lines.push('');
      lines.push('```');
      lines.push(t.text + (t.truncated ? '\n…(dipotong untuk ekspor)' : ''));
      lines.push('```');
      lines.push('');
      continue;
    }
    const msg = entry && entry.message;
    if (!msg) continue;
    const role = entryRole(entry);
    if (role === 'system') {
      const t = truncate(typeof msg.content === 'string' ? msg.content : entryText(entry), EXPORT_TOOL_INPUT_LIMIT);
      lines.push('## System prompt');
      lines.push('');
      lines.push('> ' + t.text.replace(/\n/g, '\n> ') + (t.truncated ? '\n>\n> …(dipotong untuk ekspor)' : ''));
      lines.push('');
      continue;
    }
    const heading = role === 'user' ? '## 🧑 Kamu' : '## 🤖 Agent';
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) { lines.push(heading); lines.push(''); lines.push(msg.content); lines.push(''); }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    let headed = false;
    const head = () => { if (!headed) { lines.push(heading); lines.push(''); headed = true; } };
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text && block.text.trim()) {
        head(); lines.push(block.text); lines.push('');
      } else if (block.type === 'tool_use') {
        head();
        const input = truncate(JSON.stringify(block.input || {}, null, 2), EXPORT_TOOL_INPUT_LIMIT);
        const appName = APP_TOOL_NAMES[block.name];
        const label = (block.name || '?') + (appName && appName !== block.name ? ' (' + appName + ')' : '');
        lines.push('**Tool: `' + label + '`**');
        lines.push('');
        lines.push('```json');
        lines.push(input.text + (input.truncated ? '\n…(dipotong untuk ekspor)' : ''));
        lines.push('```');
        lines.push('');
      } else if (block.type === 'tool_result') {
        head();
        const raw = typeof block.content === 'string'
          ? block.content
          : entryText({ message: { content: [block] } });
        const t = truncate(raw, EXPORT_TOOL_RESULT_LIMIT);
        lines.push('**Hasil tool' + (block.is_error ? ' (error)' : '') + ':**');
        lines.push('');
        lines.push('```');
        lines.push(t.text + (t.truncated ? '\n…(dipotong untuk ekspor)' : ''));
        lines.push('```');
        lines.push('');
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = {
  entryText, entryRole, makeSnippet, searchSessions, sessionToMarkdown,
  MAX_MATCHES_PER_SESSION, MAX_SESSIONS,
};

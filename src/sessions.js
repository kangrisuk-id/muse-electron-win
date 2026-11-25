'use strict';

/**
 * Session recording as JSONL, in the Claude Code line shape.
 *
 * Every session is appended line-by-line (one JSON object per line) to:
 *   <userData>/sessions/<id>.jsonl          (app-owned store)
 *   <workspace>/.agent-sessions/<id>.jsonl  (mirror next to the work)
 *
 * Recorded lines follow the shape the make.fun kit's claude-code reader
 * parses natively:
 *   - every line carries `version` (this app's package.json version),
 *     `harness` ("muse-agent-desktop"), an ISO `timestamp`, `sessionId`,
 *     `cwd`, and a `uuid`/`parentUuid` chain;
 *   - the first line is a `session` header holding the session meta;
 *   - a `system` line records the exact system prompt of the session;
 *   - assistant lines carry `message.content` as an ARRAY of blocks:
 *     `thinking` (when the provider returned reasoning), `text`, and
 *     `tool_use` blocks named Write/Edit/Read/Bash/LS whose inputs use the
 *     Claude Code field names (file_path, content, old_string, new_string);
 *   - tool results are `user` lines whose message content holds a
 *     `tool_result` block answering the tool_use id;
 *   - assistant messages carry the provider's usage INSIDE the message
 *     (`message.usage` with input_tokens/output_tokens), which is what
 *     transcript pricing reads.
 *
 * The app reads its own files back through historyFromEntries /
 * uiMessagesFromEntries below, which also tolerate the v1 (0.1.0) line
 * shape: OpenAI-style assistant messages and separate tool_use/tool_result
 * entry types.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HARNESS_NAME = 'muse-agent-desktop';

let APP_VERSION = '0.0.0';
try { APP_VERSION = require('../package.json').version || APP_VERSION; } catch (_) { /* keep fallback */ }

function newSessionId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return 'session-' + stamp + '-' + crypto.randomBytes(3).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Tool-call mapping: app tools <-> recorded Claude Code style blocks  */
/* ------------------------------------------------------------------ */

const TOOL_BLOCK_NAMES = {
  write_file: 'Write',
  edit_file: 'Edit',
  read_file: 'Read',
  run_command: 'Bash',
  list_dir: 'LS',
};

const APP_TOOL_NAMES = {
  Write: 'write_file',
  Edit: 'edit_file',
  Read: 'read_file',
  Bash: 'run_command',
  LS: 'list_dir',
};

function toAbsolute(workspaceRoot, p) {
  if (!p) return p || '';
  if (!workspaceRoot || path.isAbsolute(p)) return p;
  return path.join(workspaceRoot, p);
}

function toRelative(workspaceRoot, p) {
  if (!p || !workspaceRoot) return p || '';
  const abs = path.resolve(p);
  const root = path.resolve(workspaceRoot);
  if (abs === root) return '.';
  if (abs.startsWith(root + path.sep)) return abs.slice(root.length + 1);
  return p;
}

/** Map parsed app-tool arguments to the recorded block input shape. */
function blockInputFor(appToolName, args, workspaceRoot) {
  args = args || {};
  switch (appToolName) {
    case 'write_file':
      return { file_path: toAbsolute(workspaceRoot, args.path), content: String(args.content == null ? '' : args.content) };
    case 'edit_file':
      return {
        file_path: toAbsolute(workspaceRoot, args.path),
        old_string: String(args.old_text == null ? '' : args.old_text),
        new_string: String(args.new_text == null ? '' : args.new_text),
      };
    case 'read_file':
      return { file_path: toAbsolute(workspaceRoot, args.path) };
    case 'run_command':
      return { command: String(args.command == null ? '' : args.command) };
    case 'list_dir':
      return { path: toAbsolute(workspaceRoot, args.path || '.') };
    default:
      return { ...args };
  }
}

/** Map a recorded block input back to app-tool arguments. */
function appArgsFor(appToolName, input, workspaceRoot) {
  input = input || {};
  switch (appToolName) {
    case 'write_file':
      return { path: toRelative(workspaceRoot, input.file_path), content: input.content == null ? '' : String(input.content) };
    case 'edit_file':
      return {
        path: toRelative(workspaceRoot, input.file_path),
        old_text: input.old_string == null ? '' : String(input.old_string),
        new_text: input.new_string == null ? '' : String(input.new_string),
      };
    case 'read_file':
      return { path: toRelative(workspaceRoot, input.file_path) };
    case 'run_command':
      return { command: input.command == null ? '' : String(input.command) };
    case 'list_dir':
      return { path: toRelative(workspaceRoot, input.path || '.') };
    default:
      return { ...input };
  }
}

/**
 * Build one recorded tool_use block from an OpenAI-style tool call
 * ({id, function:{name, arguments}} with app tool names).
 */
function toolUseBlockFromCall(call, workspaceRoot) {
  const name = call && call.function ? call.function.name : '';
  let args = {};
  try { args = JSON.parse((call && call.function && call.function.arguments) || '{}'); } catch (_) { args = {}; }
  return {
    type: 'tool_use',
    id: call ? call.id : '',
    name: TOOL_BLOCK_NAMES[name] || name,
    input: blockInputFor(name, args, workspaceRoot),
  };
}

/** Rebuild an OpenAI-style tool call (app tool names) from a recorded block. */
function toolCallFromBlock(block, workspaceRoot) {
  const appName = APP_TOOL_NAMES[block.name] || block.name;
  return {
    id: block.id,
    type: 'function',
    function: {
      name: appName,
      arguments: JSON.stringify(appArgsFor(appName, block.input, workspaceRoot)),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Usage + assistant message recording                                 */
/* ------------------------------------------------------------------ */

/**
 * Map a provider's OpenAI-style usage object to the recorded
 * message.usage shape. Only fields the provider actually returned are
 * carried over.
 */
function usageFromProvider(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out = {};
  const input = num(usage.input_tokens) ?? num(usage.prompt_tokens);
  const output = num(usage.output_tokens) ?? num(usage.completion_tokens);
  if (input !== undefined) out.input_tokens = input;
  if (output !== undefined) out.output_tokens = output;
  const details = usage.prompt_tokens_details || {};
  const cacheRead = num(usage.cache_read_input_tokens) ?? num(details.cached_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens) ?? num(details.cache_creation_tokens);
  if (cacheRead !== undefined) out.cache_read_input_tokens = cacheRead;
  if (cacheCreation !== undefined) out.cache_creation_input_tokens = cacheCreation;
  return Object.keys(out).length ? out : null;
}

const STOP_REASONS = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

/**
 * Build the recorded assistant message (Claude Code shape) from a
 * provider response message.
 *
 * @param {object} msg  provider message ({content, tool_calls, reasoning_content})
 * @param {object} opts {model, usage (provider shape), responseId, finishReason, workspaceRoot}
 */
function assistantMessageRecord(msg, opts) {
  opts = opts || {};
  const content = [];
  if (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
    const thinking = { type: 'thinking', thinking: msg.reasoning_content };
    if (typeof msg.reasoning_signature === 'string' && msg.reasoning_signature) {
      thinking.signature = msg.reasoning_signature;
    }
    content.push(thinking);
  }
  if (msg && typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  }
  const toolCalls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const call of toolCalls) {
    content.push(toolUseBlockFromCall(call, opts.workspaceRoot));
  }
  const message = {
    role: 'assistant',
    id: opts.responseId || ('msg-' + crypto.randomBytes(6).toString('hex')),
    model: opts.model || '',
    content,
    stop_reason: STOP_REASONS[opts.finishReason] || opts.finishReason || 'end_turn',
  };
  const usage = usageFromProvider(opts.usage);
  if (usage) message.usage = usage;
  return message;
}

/** Plain text of a recorded message content (string or block array). */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function isToolResultContent(content) {
  return Array.isArray(content) && content.length > 0
    && content.every((b) => b && b.type === 'tool_result');
}

/* ------------------------------------------------------------------ */
/* Reading sessions back (app history + UI), v1 and v2 tolerant        */
/* ------------------------------------------------------------------ */

/**
 * Rebuild the OpenAI-style history (WITHOUT system prompt) from recorded
 * entries. Handles both the current block format and the v1 format.
 */
function historyFromEntries(entries, workspaceRoot) {
  const history = [];
  for (const e of entries || []) {
    if (!e || !e.message) {
      if (e && e.type === 'tool_result') { // v1 loose tool_result line
        history.push({ role: 'tool', tool_call_id: e.toolCallId, content: e.result || '' });
      }
      continue;
    }
    const m = e.message;
    if (e.type === 'user') {
      if (typeof m.content === 'string') {
        history.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_result') {
            history.push({
              role: 'tool',
              tool_call_id: b.tool_use_id,
              content: typeof b.content === 'string' ? b.content : '',
            });
          }
        }
        const text = textOfContent(m.content);
        if (text) history.push({ role: 'user', content: text });
      }
    } else if (e.type === 'assistant') {
      if (Array.isArray(m.content)) {
        const assistant = { role: 'assistant', content: textOfContent(m.content) };
        const calls = m.content
          .filter((b) => b && b.type === 'tool_use')
          .map((b) => toolCallFromBlock(b, workspaceRoot));
        if (calls.length) assistant.tool_calls = calls;
        history.push(assistant);
      } else if (typeof m.content === 'string' || Array.isArray(m.tool_calls)) {
        history.push(m); // v1: already OpenAI-shaped
      }
    } else if (e.type === 'tool_result') { // v1 recorded tool result entry
      history.push({ role: 'tool', tool_call_id: e.toolCallId, content: e.result || '' });
    }
  }
  return history;
}

/**
 * Flatten recorded entries into the renderer's message list:
 * {type: 'user'|'assistant'|'tool_use'|'tool_result', timestamp, message?,
 *  name?, args?, result?, isError?}. v1 and v2 entries both supported.
 */
function uiMessagesFromEntries(entries, workspaceRoot) {
  const out = [];
  for (const e of entries || []) {
    if (!e) continue;
    const ts = e.timestamp;
    if (e.type === 'user' && e.message) {
      if (typeof e.message.content === 'string') {
        out.push({ type: 'user', timestamp: ts, message: e.message });
      } else if (Array.isArray(e.message.content)) {
        for (const b of e.message.content) {
          if (b && b.type === 'tool_result') {
            out.push({
              type: 'tool_result', timestamp: ts, name: null,
              result: typeof b.content === 'string' ? b.content : '', isError: !!b.is_error,
            });
          }
        }
        const text = textOfContent(e.message.content);
        if (text) out.push({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
      }
    } else if (e.type === 'assistant' && e.message) {
      if (Array.isArray(e.message.content)) {
        const text = textOfContent(e.message.content);
        if (text) out.push({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: text } });
        for (const b of e.message.content) {
          if (b && b.type === 'tool_use') {
            const call = toolCallFromBlock(b, workspaceRoot);
            let args = {};
            try { args = JSON.parse(call.function.arguments); } catch (_) { args = {}; }
            out.push({ type: 'tool_use', timestamp: ts, name: call.function.name, args });
          }
        }
      } else {
        out.push({ type: 'assistant', timestamp: ts, message: e.message });
      }
    } else if (e.type === 'tool_use') { // v1
      out.push({ type: 'tool_use', timestamp: ts, name: e.name || null, args: e.args || null });
    } else if (e.type === 'tool_result') { // v1
      out.push({ type: 'tool_result', timestamp: ts, name: e.name || null, result: e.result || null, isError: !!e.isError });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

class SessionStore {
  constructor(userDataDir) {
    if (!userDataDir) throw new Error('userDataDir is required');
    this.dir = path.join(userDataDir, 'sessions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.sessions = new Map(); // id -> meta
    this.lastUuid = new Map(); // id -> uuid of the latest recorded line
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

  /**
   * Append one entry. Every line carries the harness identity, the app
   * version and a uuid chained to the previous line (parentUuid).
   */
  append(meta, type, data) {
    const uuid = crypto.randomUUID();
    const entry = {
      type,
      uuid,
      parentUuid: this.lastUuid.get(meta.id) ?? null,
      timestamp: new Date().toISOString(),
      sessionId: meta.id,
      cwd: meta.cwd,
      version: APP_VERSION,
      harness: HARNESS_NAME,
      isSidechain: false,
      userType: 'external',
      provider: meta.provider,
      model: meta.model,
      ...(data || {}),
    };
    this.lastUuid.set(meta.id, uuid);
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
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] && entries[i].uuid) { this.lastUuid.set(id, entries[i].uuid); break; }
    }
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
      const firstUser = entries.find(
        (e) => e.type === 'user' && e.message && !isToolResultContent(e.message.content)
      );
      out.push({
        id,
        createdAt: head ? head.timestamp : '',
        cwd: head && head.meta ? head.meta.cwd : '',
        provider: head && head.meta ? head.meta.provider : '',
        model: head && head.meta ? head.meta.model : '',
        messages: entries.filter(
          (e) => e.type === 'assistant'
            || (e.type === 'user' && e.message && !isToolResultContent(e.message.content))
        ).length,
        preview: firstUser ? textOfContent(firstUser.message.content).slice(0, 80) : '',
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }
}

module.exports = {
  SessionStore,
  newSessionId,
  HARNESS_NAME,
  APP_VERSION,
  TOOL_BLOCK_NAMES,
  APP_TOOL_NAMES,
  toolUseBlockFromCall,
  toolCallFromBlock,
  usageFromProvider,
  assistantMessageRecord,
  textOfContent,
  historyFromEntries,
  uiMessagesFromEntries,
};

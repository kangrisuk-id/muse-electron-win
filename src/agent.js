'use strict';

/**
 * The agent loop: chat completions with tool calling.
 *
 * One user turn = repeated rounds of (model call -> tool calls -> results)
 * until the model answers without tool calls (or MAX_ROUNDS is hit).
 * Everything is streamed to the UI via onEvent and recorded to the session.
 */

const { chatCompletion } = require('./providers');

const MAX_ROUNDS = 30;

const BASE_SYSTEM_PROMPT = [
  'Kamu adalah agent AI desktop yang bekerja langsung di folder workspace milik user.',
  'Kamu punya tool: read_file, write_file, edit_file, list_dir, run_command — semuanya',
  'terbatas di dalam workspace. Pakai tool untuk benar-benar mengerjakan tugas, bukan',
  'sekadar memberi saran. Tulis file lewat tool dalam langkah-langkah yang tulus.',
  'Jawab dalam Bahasa Indonesia kecuali user memakai bahasa lain. Laporkan hasil',
  'dengan jujur, termasuk kegagalan.',
].join(' ');

function buildSystemPrompt({ workspace, makefunRules }) {
  let prompt = BASE_SYSTEM_PROMPT + '\n\nWorkspace saat ini: ' + (workspace || '(belum dipilih)');
  if (makefunRules) {
    prompt += '\n\n=== MODE MAKE.FUN AKTIF ===\n' + makefunRules;
  }
  return prompt;
}

/**
 * Run one user turn.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.history   OpenAI-style messages WITHOUT the system prompt.
 *                                Mutated in place (user/assistant/tool appended).
 * @param {object} opts.toolRunner  from tools.createToolRunner
 * @param {object} opts.session     {store, meta} or null
 * @param {string} opts.workspace
 * @param {string|null} opts.makefunRules  rules text when make.fun mode is on
 * @param {function} opts.onEvent   ({kind, ...}) => void
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{finalText: string, rounds: number}>}
 */
async function runAgentTurn(opts) {
  const {
    providerId, apiKey, model, history, toolRunner,
    session, workspace, makefunRules, onEvent, signal,
  } = opts;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const record = (type, data) => {
    if (session && session.store && session.meta) {
      try { session.store.append(session.meta, type, data); } catch (_) { /* recording is best-effort */ }
    }
  };

  const userMessage = history[history.length - 1];
  if (userMessage && userMessage.role === 'user') {
    record('user', { message: userMessage });
  }

  const systemPrompt = buildSystemPrompt({ workspace, makefunRules });
  let finalText = '';

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal && signal.aborted) throw new Error('Dibatalkan oleh user.');

    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    const json = await chatCompletion({
      providerId, apiKey, model, messages,
      tools: toolRunner ? toolRunner.defs : [],
      signal,
    });
    const msg = json.choices[0].message;
    const assistantMessage = { role: 'assistant', content: msg.content || '' };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      assistantMessage.tool_calls = msg.tool_calls;
    }
    history.push(assistantMessage);
    record('assistant', { message: assistantMessage, usage: json.usage || null, round });
    if (assistantMessage.content) {
      finalText = assistantMessage.content;
      emit({ kind: 'assistant', content: assistantMessage.content, round });
    }

    const toolCalls = assistantMessage.tool_calls || [];
    if (toolCalls.length === 0) {
      return { finalText, rounds: round };
    }

    for (const call of toolCalls) {
      const name = call.function && call.function.name;
      let args = {};
      try { args = JSON.parse((call.function && call.function.arguments) || '{}'); }
      catch (_) { args = {}; }
      emit({ kind: 'tool_call', id: call.id, name, args, round });
      record('tool_use', { toolCallId: call.id, name, args, round });

      let resultText;
      let isError = false;
      try {
        resultText = await toolRunner.execute(name, args);
      } catch (err) {
        isError = true;
        resultText = 'ERROR: ' + (err && err.message ? err.message : String(err));
      }
      emit({ kind: 'tool_result', id: call.id, name, result: resultText, isError, round });
      record('tool_result', { toolCallId: call.id, name, result: resultText, isError, round });

      history.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  emit({ kind: 'assistant', content: '(Berhenti: batas ' + MAX_ROUNDS + ' putaran tool tercapai.)', round: MAX_ROUNDS });
  return { finalText, rounds: MAX_ROUNDS };
}

module.exports = { runAgentTurn, buildSystemPrompt, BASE_SYSTEM_PROMPT, MAX_ROUNDS };

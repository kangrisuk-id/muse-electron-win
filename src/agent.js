'use strict';

/**
 * The agent loop: chat completions with tool calling.
 *
 * One user turn = repeated rounds of (model call -> tool calls -> results)
 * until the model answers without tool calls (or MAX_ROUNDS is hit).
 * Everything is streamed to the UI via onEvent and recorded to the session.
 */

const { chatCompletion, chatCompletionStream } = require('./providers');
const { assistantMessageRecord } = require('./sessions');
const { isMutatingTool } = require('./permissions');

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
 * @param {function} [opts.onDelta] Stage 9: (deltaText) => void. When
 *   provided, the turn streams (SSE) and 'assistant_delta' events are
 *   emitted per fragment; the final 'assistant' event still carries
 *   the complete text.
 * @param {function} [opts.approveTool] Stage 7: async (name, args) =>
 *   boolean, consulted before MUTATING tools only. Absent = everything
 *   allowed. A denied call never executes; the model gets a denial
 *   tool result and a 'tool_denied' event is emitted.
 * @returns {Promise<{finalText: string, rounds: number}>}
 */
async function runAgentTurn(opts) {
  const {
    providerId, apiKey, model, history, toolRunner,
    session, workspace, makefunRules, onEvent, signal, approveTool,
    onDelta, fetchImpl,
  } = opts;
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const record = (type, data) => {
    if (session && session.store && session.meta) {
      try { session.store.append(session.meta, type, data); } catch (_) { /* recording is best-effort */ }
    }
  };

  const systemPrompt = buildSystemPrompt({ workspace, makefunRules });

  // Record the exact system prompt once per session, at its start, before
  // the first user line: transcript readers price and judge a session
  // against the instructions it actually ran under.
  if (session && session.meta && !session.meta.systemPromptRecorded) {
    record('system', { message: { role: 'system', content: systemPrompt } });
    session.meta.systemPromptRecorded = true;
  }

  const userMessage = history[history.length - 1];
  if (userMessage && userMessage.role === 'user') {
    record('user', { message: userMessage });
  }

  let finalText = '';

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (signal && signal.aborted) throw new Error('Dibatalkan oleh user.');

    const messages = [{ role: 'system', content: systemPrompt }, ...history];
    // Stage 9: stream when a delta observer is attached (the UI),
    // otherwise the plain completion (tests, headless callers).
    const completionArgs = {
      providerId, apiKey, model, messages,
      tools: toolRunner ? toolRunner.defs : [],
      signal, fetchImpl,
    };
    const json = typeof onDelta === 'function'
      ? await chatCompletionStream({
          ...completionArgs,
          onDelta: (delta) => {
            try { onDelta(delta); } catch (_) { /* observer errors never break the turn */ }
            emit({ kind: 'assistant_delta', delta, round });
          },
        })
      : await chatCompletion(completionArgs);
    const msg = json.choices[0].message;
    const assistantMessage = { role: 'assistant', content: msg.content || '' };
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      assistantMessage.tool_calls = msg.tool_calls;
    }
    history.push(assistantMessage);
    // Record in the Claude Code line shape: content blocks (thinking /
    // text / tool_use) and the provider usage inside the message.
    record('assistant', {
      message: assistantMessageRecord(msg, {
        model,
        usage: json.usage || null,
        responseId: json.id || null,
        finishReason: json.choices[0].finish_reason || null,
        workspaceRoot: workspace,
      }),
    });
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

      let resultText;
      let isError = false;
      let denied = false;
      if (typeof approveTool === 'function' && isMutatingTool(name)) {
        let approved = false;
        try { approved = await approveTool(name, args); } catch (_) { approved = false; }
        if (!approved) {
          denied = true;
          isError = true;
          resultText = 'DITOLAK oleh user: tool ' + name + ' tidak diizinkan. '
            + 'Jangan mencoba mengulang panggilan yang sama; lanjutkan tanpa tool ini atau sampaikan ke user.';
          emit({ kind: 'tool_denied', id: call.id, name, round });
        }
      }
      if (!denied) {
        try {
          resultText = await toolRunner.execute(name, args);
        } catch (err) {
          isError = true;
          resultText = 'ERROR: ' + (err && err.message ? err.message : String(err));
        }
      }
      emit({ kind: 'tool_result', id: call.id, name, result: resultText, isError, round });
      // Record the result as a user line holding a tool_result block that
      // answers the tool_use id, the shape transcript readers pair up.
      const resultBlock = { type: 'tool_result', tool_use_id: call.id, content: resultText };
      if (isError) resultBlock.is_error = true;
      record('user', {
        message: { role: 'user', content: [resultBlock] },
        toolUseResult: resultText,
      });

      history.push({ role: 'tool', tool_call_id: call.id, content: resultText });
    }
  }

  emit({ kind: 'assistant', content: '(Berhenti: batas ' + MAX_ROUNDS + ' putaran tool tercapai.)', round: MAX_ROUNDS });
  return { finalText, rounds: MAX_ROUNDS };
}

module.exports = { runAgentTurn, buildSystemPrompt, BASE_SYSTEM_PROMPT, MAX_ROUNDS };

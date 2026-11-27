'use strict';

/**
 * Provider catalogue + a single OpenAI-compatible chat-completions client.
 *
 * All four providers speak the same wire protocol (POST <base>/chat/completions
 * with a Bearer key), so one client serves them all. Gemini and NVIDIA model
 * IDs are taken verbatim from the proven OpenTask catalogue
 * (~/workspace/opencode-redmi6 .../Providers.java).
 */

const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyHint: 'Ambil API key gratis di Google AI Studio: aistudio.google.com/apikey',
    models: [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash — bawaan, cepat & pintar' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite — paling hemat' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — stabil' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — paling kuat (seri 2.5)' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite — hemat & stabil' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'API key dari platform.openai.com/api-keys (awalan sk-)',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o — bawaan' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini — cepat & hemat' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'API key dari openrouter.ai/keys (awalan sk-or-)',
    models: [
      { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4 — bawaan' },
      { id: 'openai/gpt-4o', label: 'GPT-4o' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    ],
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyHint: 'Ambil API key gratis (tanpa kartu kredit) di build.nvidia.com → API Keys (awalan nvapi-)',
    models: [
      { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B — bawaan, seimbang' },
      { id: 'qwen/qwen3-coder-480b-a35b-instruct', label: 'Qwen3 Coder 480B — terbaik untuk kode' },
      { id: 'qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B — kode, lebih cepat' },
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 — penalaran dalam' },
      { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'Nemotron 3 Super 120B — andalan NVIDIA' },
      { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', label: 'Nemotron Super 49B — ringan dari NVIDIA' },
      { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 — penalaran & agen' },
      { id: 'meta/llama-3.1-405b-instruct', label: 'Llama 3.1 405B — terbesar' },
      { id: 'meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B — paling cepat' },
    ],
  },
};

const PROVIDER_ORDER = ['gemini', 'openai', 'openrouter', 'nvidia'];

function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.gemini;
}

function listProviders() {
  return PROVIDER_ORDER.map((id) => PROVIDERS[id]);
}

function defaultModel(providerId) {
  const p = getProvider(providerId);
  return p.models.length ? p.models[0].id : '';
}

function chatCompletionsUrl(providerId) {
  const base = getProvider(providerId).baseUrl.replace(/\/+$/, '');
  return base + '/chat/completions';
}

/**
 * Build the exact fetch request for a chat completion. Split out from the
 * network call so tests can assert on it without any network.
 */
function buildChatRequest({ providerId, apiKey, model, messages, tools, stream }) {
  const body = {
    model: model || defaultModel(providerId),
    messages,
  };
  if (stream) {
    body.stream = true;
    // Ask for a final usage chunk; providers that do not support the
    // option simply omit it and usage stays null (never invented).
    body.stream_options = { include_usage: true };
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return {
    url: chatCompletionsUrl(providerId),
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (apiKey || ''),
      },
      body: JSON.stringify(body),
    },
  };
}

/**
 * Run one chat completion. `fetchImpl` is injectable for tests.
 * Returns the parsed response JSON; throws an Error with HTTP context.
 */
async function chatCompletion({ providerId, apiKey, model, messages, tools, fetchImpl, signal }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('fetch is not available in this runtime');
  }
  if (!apiKey) {
    throw new Error('API key untuk provider "' + getProvider(providerId).label + '" belum diisi. Buka Settings.');
  }
  const { url, options } = buildChatRequest({ providerId, apiKey, model, messages, tools });
  if (signal) options.signal = signal;
  const res = await doFetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* keep null */ }
  if (!res.ok) {
    const detail = (json && json.error && (json.error.message || json.error)) || text.slice(0, 400);
    throw new Error('Provider error HTTP ' + res.status + ': ' + detail);
  }
  if (!json || !Array.isArray(json.choices) || !json.choices[0] || !json.choices[0].message) {
    throw new Error('Respons provider tidak terduga: ' + text.slice(0, 400));
  }
  return json;
}

/* ------------------------- Stage 9: streaming ------------------------- */

/**
 * Assemble one streamed completion from parsed SSE chunks (pure).
 * Content fragments are concatenated; tool_calls are assembled by
 * index (id/name arrive first, arguments stream as fragments); usage
 * is taken from any chunk that carries it (normally the last one).
 */
function assembleStreamChunks(chunks) {
  let id = null;
  let model = null;
  let finishReason = null;
  let usage = null;
  let content = '';
  const toolByIndex = new Map();
  for (const chunk of chunks || []) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : toolByIndex.size;
        const cur = toolByIndex.get(idx) || {
          id: '', type: 'function', function: { name: '', arguments: '' },
        };
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function) {
          if (tc.function.name) cur.function.name += tc.function.name;
          if (typeof tc.function.arguments === 'string') cur.function.arguments += tc.function.arguments;
        }
        toolByIndex.set(idx, cur);
      }
    }
  }
  const message = { role: 'assistant', content };
  if (toolByIndex.size > 0) {
    message.tool_calls = [...toolByIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => tc);
  }
  return { id, model, usage, choices: [{ message, finish_reason: finishReason }] };
}

/** Parse an SSE text block into JSON chunks (pure; skips [DONE]/junk). */
function parseSseEvents(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { out.push(JSON.parse(data)); } catch (_) { /* partial line, skip */ }
  }
  return out;
}

/**
 * Incrementally consume an SSE response body: each complete line is
 * parsed as soon as it arrives, content fragments are forwarded to
 * onDelta IMMEDIATELY (that is the point of streaming), and the parsed
 * chunks are collected for final assembly. Returns the raw text too,
 * for the non-SSE fallback path.
 */
async function consumeStreamBody(res, onDelta) {
  const chunks = [];
  let rawText = '';
  let buffer = '';
  const decoder = new TextDecoder('utf8');
  const feed = (text) => {
    rawText += text;
    buffer += text;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const parsed = parseSseEvents(line);
      for (const chunk of parsed) {
        chunks.push(chunk);
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
        const delta = choice && choice.delta && typeof choice.delta.content === 'string'
          ? choice.delta.content : '';
        if (delta && typeof onDelta === 'function') onDelta(delta);
      }
    }
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } else if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    for await (const value of res.body) {
      feed(typeof value === 'string' ? value : decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } else {
    feed(await res.text());
  }
  if (buffer.trim()) {
    for (const chunk of parseSseEvents(buffer)) chunks.push(chunk);
  }
  return { chunks, rawText };
}

/**
 * Streaming variant of chatCompletion. Emits content fragments through
 * onDelta as they arrive and resolves to the SAME response shape as
 * chatCompletion, so the agent loop consumes both identically. If the
 * provider answers with a plain (non-SSE) JSON body, it is used as-is.
 */
async function chatCompletionStream({ providerId, apiKey, model, messages, tools, fetchImpl, signal, onDelta }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('fetch is not available in this runtime');
  }
  if (!apiKey) {
    throw new Error('API key untuk provider "' + getProvider(providerId).label + '" belum diisi. Buka Settings.');
  }
  const { url, options } = buildChatRequest({ providerId, apiKey, model, messages, tools, stream: true });
  if (signal) options.signal = signal;
  const res = await doFetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* keep null */ }
    const detail = (json && json.error && (json.error.message || json.error)) || String(text).slice(0, 400);
    throw new Error('Provider error HTTP ' + res.status + ': ' + detail);
  }
  const { chunks, rawText } = await consumeStreamBody(res, onDelta);
  if (chunks.length === 0) {
    // Not an SSE answer (proxy/provider ignored stream): plain JSON.
    let json = null;
    try { json = JSON.parse(rawText); } catch (_) { /* keep null */ }
    if (json && Array.isArray(json.choices) && json.choices[0] && json.choices[0].message) {
      const content = json.choices[0].message.content || '';
      if (content && typeof onDelta === 'function') onDelta(content);
      return json;
    }
    throw new Error('Respons provider tidak terduga: ' + String(rawText).slice(0, 400));
  }
  const assembled = assembleStreamChunks(chunks);
  if (!assembled.choices[0].message) {
    throw new Error('Respons provider tidak terduga (stream kosong).');
  }
  return assembled;
}

module.exports = {
  PROVIDERS,
  PROVIDER_ORDER,
  getProvider,
  listProviders,
  defaultModel,
  chatCompletionsUrl,
  buildChatRequest,
  chatCompletion,
  chatCompletionStream,
  parseSseEvents,
  assembleStreamChunks,
};

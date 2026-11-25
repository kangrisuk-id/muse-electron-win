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
function buildChatRequest({ providerId, apiKey, model, messages, tools }) {
  const body = {
    model: model || defaultModel(providerId),
    messages,
  };
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

module.exports = {
  PROVIDERS,
  PROVIDER_ORDER,
  getProvider,
  listProviders,
  defaultModel,
  chatCompletionsUrl,
  buildChatRequest,
  chatCompletion,
};

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDERS, PROVIDER_ORDER, getProvider, listProviders,
  defaultModel, chatCompletionsUrl, buildChatRequest, chatCompletion,
} = require('../src/providers');

test('catalogue has exactly the four required providers', () => {
  assert.deepEqual(PROVIDER_ORDER, ['gemini', 'openai', 'openrouter', 'nvidia']);
  assert.equal(listProviders().length, 4);
});

test('base URLs are the exact OpenAI-compatible endpoints', () => {
  assert.equal(PROVIDERS.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/');
  assert.equal(PROVIDERS.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(PROVIDERS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(PROVIDERS.nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
});

test('chat completions URL joins cleanly with or without trailing slash', () => {
  assert.equal(chatCompletionsUrl('gemini'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(chatCompletionsUrl('openai'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('nvidia'), 'https://integrate.api.nvidia.com/v1/chat/completions');
});

test('gemini models match the proven OpenTask catalogue, default first', () => {
  assert.deepEqual(
    PROVIDERS.gemini.models.map((m) => m.id),
    ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']
  );
  assert.equal(defaultModel('gemini'), 'gemini-3.5-flash');
});

test('nvidia models match the proven OpenTask catalogue, default first', () => {
  assert.deepEqual(
    PROVIDERS.nvidia.models.map((m) => m.id),
    [
      'meta/llama-3.3-70b-instruct',
      'qwen/qwen3-coder-480b-a35b-instruct',
      'qwen/qwen2.5-coder-32b-instruct',
      'deepseek-ai/deepseek-r1',
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'moonshotai/kimi-k2-instruct',
      'meta/llama-3.1-405b-instruct',
      'meta/llama-3.1-8b-instruct',
    ]
  );
  assert.equal(defaultModel('nvidia'), 'meta/llama-3.3-70b-instruct');
});

test('openai and openrouter model lists match the spec', () => {
  assert.deepEqual(PROVIDERS.openai.models.map((m) => m.id), ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']);
  assert.deepEqual(
    PROVIDERS.openrouter.models.map((m) => m.id),
    ['anthropic/claude-sonnet-4', 'openai/gpt-4o', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat']
  );
});

test('buildChatRequest forms the correct request', () => {
  const { url, options } = buildChatRequest({
    providerId: 'nvidia',
    apiKey: 'nvapi-test',
    model: 'meta/llama-3.3-70b-instruct',
    messages: [{ role: 'user', content: 'halo' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
  });
  assert.equal(url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer nvapi-test');
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'meta/llama-3.3-70b-instruct');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'halo' }]);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tool_choice, 'auto');
});

test('buildChatRequest falls back to the provider default model', () => {
  const { options } = buildChatRequest({ providerId: 'openai', apiKey: 'sk-x', messages: [] });
  assert.equal(JSON.parse(options.body).model, 'gpt-4o');
});

test('chatCompletion sends through a mocked fetch and returns parsed JSON', async () => {
  let seenUrl = null;
  let seenOptions = null;
  const mockFetch = async (url, options) => {
    seenUrl = url; seenOptions = options;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'siap' } }] }),
    };
  };
  const json = await chatCompletion({
    providerId: 'gemini', apiKey: 'k', model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hai' }], fetchImpl: mockFetch,
  });
  assert.equal(seenUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(seenOptions.headers.Authorization, 'Bearer k');
  assert.equal(json.choices[0].message.content, 'siap');
});

test('chatCompletion throws a readable error on HTTP failure', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
  });
  await assert.rejects(
    chatCompletion({ providerId: 'openai', apiKey: 'bad', model: 'gpt-4o', messages: [], fetchImpl: mockFetch }),
    /HTTP 401: invalid api key/
  );
});

test('chatCompletion refuses an empty API key before any request', async () => {
  await assert.rejects(
    chatCompletion({ providerId: 'openai', apiKey: '', model: 'gpt-4o', messages: [], fetchImpl: async () => { throw new Error('must not be called'); } }),
    /belum diisi/
  );
});

test('unknown provider id falls back to gemini', () => {
  assert.equal(getProvider('nope').id, 'gemini');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSseEvents, assembleStreamChunks, chatCompletionStream, buildChatRequest,
} = require('../src/providers');
const { runAgentTurn } = require('../src/agent');

function sse(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }

function chunk(delta, extra) {
  return { id: 'chatcmpl-1', model: 'm', choices: [{ delta, finish_reason: null }], ...(extra || {}) };
}

test('parseSseEvents skips [DONE], blanks and junk lines', () => {
  const text = ': comment\n\ndata: {"a":1}\n\ndata: [DONE]\n\ndata: bukan-json\ndata: {"b":2}\n';
  assert.deepEqual(parseSseEvents(text), [{ a: 1 }, { b: 2 }]);
});

test('assembleStreamChunks joins content, assembles tool_calls by index, keeps usage', () => {
  const chunks = [
    chunk({ role: 'assistant', content: 'Ha' }),
    chunk({ content: 'lo' }),
    chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '.txt","content":"x"}' } }] }),
    chunk({}, {}),
    { id: 'chatcmpl-1', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  const out = assembleStreamChunks(chunks);
  assert.equal(out.choices[0].message.content, 'Halo');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  const tc = out.choices[0].message.tool_calls;
  assert.equal(tc.length, 1);
  assert.equal(tc[0].id, 'c1');
  assert.equal(tc[0].function.name, 'write_file');
  assert.equal(tc[0].function.arguments, '{"path":"a.txt","content":"x"}');
});

test('buildChatRequest with stream asks for stream + usage', () => {
  const { options } = buildChatRequest({ providerId: 'gemini', apiKey: 'k', model: 'm', messages: [], stream: true });
  const body = JSON.parse(options.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

function sseResponse(fullText, splitAt) {
  const enc = new TextEncoder();
  const parts = [fullText.slice(0, splitAt), fullText.slice(splitAt)].filter((s) => s.length > 0);
  return {
    ok: true, status: 200,
    body: {
      [Symbol.asyncIterator]: async function* () {
        for (const p of parts) yield enc.encode(p);
      },
    },
    text: async () => fullText,
  };
}

test('chatCompletionStream streams deltas live and assembles across mid-line splits', async () => {
  const full = sse(chunk({ content: 'Selamat ' })) + sse(chunk({ content: 'pagi' }))
    + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 9 } }) + 'data: [DONE]\n\n';
  const deltas = [];
  const out = await chatCompletionStream({
    providerId: 'gemini', apiKey: 'k', model: 'm', messages: [],
    fetchImpl: async () => sseResponse(full, 17), // split inside the first JSON line
    onDelta: (d) => deltas.push(d),
  });
  assert.deepEqual(deltas, ['Selamat ', 'pagi']);
  assert.equal(out.choices[0].message.content, 'Selamat pagi');
  assert.deepEqual(out.usage, { total_tokens: 9 });
});

test('chatCompletionStream falls back to plain JSON when the provider ignores stream', async () => {
  const json = { id: 'x', choices: [{ message: { role: 'assistant', content: 'utuh' }, finish_reason: 'stop' }] };
  const deltas = [];
  const out = await chatCompletionStream({
    providerId: 'openai', apiKey: 'k', model: 'm', messages: [],
    fetchImpl: async () => ({
      ok: true, status: 200,
      body: { [Symbol.asyncIterator]: async function* () { yield new TextEncoder().encode(JSON.stringify(json)); } },
      text: async () => JSON.stringify(json),
    }),
    onDelta: (d) => deltas.push(d),
  });
  assert.equal(out.choices[0].message.content, 'utuh');
  assert.deepEqual(deltas, ['utuh']);
});

test('chatCompletionStream surfaces HTTP errors readably', async () => {
  await assert.rejects(
    chatCompletionStream({
      providerId: 'openai', apiKey: 'bad', model: 'm', messages: [],
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"invalid api key"}}' }),
      onDelta: () => {},
    }),
    /HTTP 401: invalid api key/
  );
});

test('agent: streaming turn emits deltas, executes streamed tool call, ends with full text', async () => {
  const original = globalThis.fetch;
  const sseTool = sse(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }))
    + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const sseText = sse(chunk({ content: 'Isi' })) + sse(chunk({ content: ' file: halo' }))
    + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  const bodies = [sseTool, sseText];
  let call = 0;
  globalThis.fetch = async () => sseResponse(bodies[Math.min(call++, bodies.length - 1)], 11);
  try {
    const events = [];
    const executed = [];
    const history = [{ role: 'user', content: 'baca a.txt' }];
    const res = await runAgentTurn({
      providerId: 'gemini', apiKey: 'k', model: 'm', history,
      toolRunner: { defs: [], execute: async (name) => { executed.push(name); return 'halo'; } },
      session: null, workspace: '/tmp/ws', makefunRules: null,
      onEvent: (e) => events.push(e),
      onDelta: () => {},
    });
    assert.deepEqual(executed, ['read_file']);
    assert.equal(res.finalText, 'Isi file: halo');
    const deltas = events.filter((e) => e.kind === 'assistant_delta').map((e) => e.delta);
    assert.deepEqual(deltas, ['Isi', ' file: halo']);
  } finally {
    globalThis.fetch = original;
  }
});

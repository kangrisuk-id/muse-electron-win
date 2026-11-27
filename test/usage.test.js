'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRICING, pricingFor, usageOfEntry, estimateCost,
  summarizeEntries, summarizeSessions,
  formatTokens, formatUSD, formatDuration,
} = require('../src/usage');

function v2Assistant(model, usage, extra) {
  return {
    type: 'assistant',
    timestamp: '2026-11-25T10:00:00.000Z',
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], usage },
    ...(extra || {}),
  };
}

test('usageOfEntry reads the Stage 1b message.usage shape', () => {
  const u = usageOfEntry(v2Assistant('gemini-2.5-flash',
    { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300 }));
  assert.deepEqual(u, {
    inputTokens: 1000, outputTokens: 200,
    cacheReadTokens: 300, cacheCreationTokens: 0,
    model: 'gemini-2.5-flash',
  });
});

test('usageOfEntry reads the v1 top-level OpenAI usage shape', () => {
  const u = usageOfEntry({
    type: 'assistant', timestamp: '2026-11-25T10:00:00.000Z', model: 'gpt-4o',
    message: { role: 'assistant', content: '', tool_calls: [] },
    usage: { prompt_tokens: 500, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } },
  });
  assert.equal(u.inputTokens, 500);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.cacheReadTokens, 100);
  assert.equal(u.model, 'gpt-4o');
});

test('usageOfEntry returns null for non-assistant and usage-less entries', () => {
  assert.equal(usageOfEntry({ type: 'user', message: { role: 'user', content: 'hi' } }), null);
  assert.equal(usageOfEntry(v2Assistant('gpt-4o', null)), null);
  assert.equal(usageOfEntry(v2Assistant('gpt-4o', { input_tokens: 0, output_tokens: 0 })), null);
  assert.equal(usageOfEntry(null), null);
});

test('estimateCost prices known models and refuses unknown ones', () => {
  // gpt-4o: $2.50 / $10.00 per 1M
  const c = estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gpt-4o');
  assert.ok(Math.abs(c - 12.5) < 1e-9);
  assert.equal(estimateCost({ inputTokens: 100, outputTokens: 100 }, 'model-ngawur'), null);
  assert.equal(estimateCost({ inputTokens: 100, outputTokens: 100 }, ''), null);
  // NIM hosted models are explicitly priced 0 (free dev endpoint)
  assert.equal(estimateCost({ inputTokens: 1e6, outputTokens: 1e6 }, 'meta/llama-3.3-70b-instruct'), 0);
  assert.ok(PRICING['gemini-2.5-flash']);
  assert.equal(pricingFor('tidak-ada'), null);
});

test('summarizeEntries totals tokens, cost, turns, tools and duration', () => {
  const entries = [
    { type: 'session', timestamp: '2026-11-25T10:00:00.000Z', meta: { id: 's1', provider: 'gemini', model: 'gemini-2.5-flash', cwd: '/tmp/ws' } },
    { type: 'system', timestamp: '2026-11-25T10:00:01.000Z', message: { role: 'system', content: 'SYS' } },
    { type: 'user', timestamp: '2026-11-25T10:00:02.000Z', message: { role: 'user', content: 'halo' } },
    {
      type: 'assistant', timestamp: '2026-11-25T10:00:10.000Z',
      message: {
        role: 'assistant', model: 'gemini-2.5-flash',
        content: [
          { type: 'text', text: 'kutulis' },
          { type: 'tool_use', id: 'c1', name: 'Write', input: { file_path: '/tmp/ws/a.txt', content: 'x' } },
          { type: 'tool_use', id: 'c2', name: 'Read', input: { file_path: '/tmp/ws/a.txt' } },
        ],
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
    },
    {
      type: 'user', timestamp: '2026-11-25T10:00:12.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    },
    v2Assistant('gemini-2.5-flash', { input_tokens: 1500, output_tokens: 12 }),
  ];
  entries[5].timestamp = '2026-11-25T10:01:02.000Z';

  const s = summarizeEntries(entries);
  assert.equal(s.provider, 'gemini');
  assert.equal(s.model, 'gemini-2.5-flash');
  assert.equal(s.userMessages, 1, 'tool_result user lines are not user messages');
  assert.equal(s.assistantTurns, 2);
  assert.equal(s.toolCalls, 2);
  assert.equal(s.toolResults, 1);
  assert.equal(s.inputTokens, 2500);
  assert.equal(s.outputTokens, 212);
  assert.equal(s.totalTokens, 2712);
  // 2500 in @ $0.30/1M + 212 out @ $2.50/1M
  assert.ok(Math.abs(s.costUSD - (0.00075 + 0.00053)) < 1e-9, 'cost ' + s.costUSD);
  assert.equal(s.pricedTurns, 2);
  assert.equal(s.unpricedTurns, 0);
  assert.equal(s.durationMs, 62000);
  assert.equal(s.turns.length, 2);
  assert.equal(s.turns[0].inputTokens, 1000);
  assert.ok(s.byModel['gemini-2.5-flash']);
  assert.equal(s.byModel['gemini-2.5-flash'].totalTokens, 2712);
});

test('summarizeEntries keeps unpriced models honest (cost 0, tokens flagged)', () => {
  const s = summarizeEntries([
    v2Assistant('model-misterius', { input_tokens: 5000, output_tokens: 500 }),
  ]);
  assert.equal(s.costUSD, 0);
  assert.equal(s.unpricedTurns, 1);
  assert.equal(s.unpricedTokens, 5500);
  assert.equal(s.turns[0].costUSD, null);
});

test('summarizeEntries counts v1 tool_use/tool_result lines', () => {
  const s = summarizeEntries([
    { type: 'user', timestamp: '2026-11-25T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'tool_use', timestamp: '2026-11-25T10:00:01.000Z', name: 'read_file' },
    { type: 'tool_result', timestamp: '2026-11-25T10:00:02.000Z', name: 'read_file', result: 'isi' },
  ]);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.toolResults, 1);
  assert.equal(s.userMessages, 1);
});

test('summarizeSessions aggregates across sessions and models', () => {
  const a = summarizeEntries([v2Assistant('gpt-4o', { input_tokens: 1e6, output_tokens: 0 })]);
  const b = summarizeEntries([v2Assistant('gpt-4o-mini', { input_tokens: 0, output_tokens: 1e6 })]);
  const all = summarizeSessions([
    { id: 's1', summary: a },
    { id: 's2', summary: b },
  ]);
  assert.equal(all.sessions, 2);
  assert.equal(all.totalTokens, 2e6);
  assert.ok(Math.abs(all.costUSD - (2.5 + 0.6)) < 1e-9);
  assert.equal(all.byModel['gpt-4o'].inputTokens, 1e6);
  assert.equal(all.byModel['gpt-4o-mini'].outputTokens, 1e6);
  assert.deepEqual(summarizeSessions([]).sessions, 0);
});

test('formatters render Indonesian compact numbers, USD and durations', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1500), '1.5 rb');
  assert.equal(formatTokens(2500000), '2.5 jt');
  assert.equal(formatUSD(0), '$0');
  assert.equal(formatUSD(0.00128), '$0.0013');
  assert.equal(formatUSD(12.5), '$12.50');
  assert.equal(formatUSD(null), '—');
  assert.equal(formatDuration(45000), '45 dtk');
  assert.equal(formatDuration(125000), '2 mnt 5 dtk');
  assert.equal(formatDuration(3660000), '1 jam 1 mnt');
});

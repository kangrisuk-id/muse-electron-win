'use strict';

/**
 * Stage 4 — session usage & cost accounting.
 *
 * Pure functions over recorded session entries (the JSONL lines written
 * by src/sessions.js). No I/O, no Electron: main.js loads the entries,
 * this module summarises them, the renderer only displays the result.
 *
 * Usage lives in two places depending on the recording version:
 *   - current (Stage 1b+): assistant entry -> message.usage with
 *     {input_tokens, output_tokens, cache_read_input_tokens?,
 *      cache_creation_input_tokens?}
 *   - v1 (0.1.0): assistant entry -> top-level `usage` in the provider's
 *     OpenAI shape {prompt_tokens, completion_tokens, ...}, and in some
 *     lines also message.tool_calls in OpenAI shape.
 * Both shapes are read here so old sessions still get a panel.
 *
 * Cost is an ESTIMATE from the static price table below (USD per
 * 1,000,000 tokens, public list prices as of Nov 2026). It is not a
 * bill: free tiers, credits, discounts and price changes are not
 * reflected. Models missing from the table report cost = null
 * ("tidak diketahui"), never a fabricated 0 — except NVIDIA NIM hosted
 * models, which are listed explicitly at 0 with the free-tier note,
 * because that endpoint is served free for development use.
 */

const PRICING = {
  // Google Gemini (per 1M tokens, input / output)
  'gemini-3.5-flash': { input: 0.15, output: 0.60, note: 'estimasi' },
  'gemini-3.5-flash-lite': { input: 0.075, output: 0.30, note: 'estimasi' },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  // OpenRouter (model ids carry a vendor prefix)
  'anthropic/claude-sonnet-4': { input: 3.00, output: 15.00 },
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'google/gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'deepseek/deepseek-chat': { input: 0.27, output: 1.10 },
  // NVIDIA NIM hosted endpoint — free for development use.
  'meta/llama-3.3-70b-instruct': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'qwen/qwen3-coder-480b-a35b-instruct': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'qwen/qwen2.5-coder-32b-instruct': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'deepseek-ai/deepseek-r1': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'nvidia/nemotron-3-super-120b-a12b': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'nvidia/llama-3.3-nemotron-super-49b-v1': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'moonshotai/kimi-k2-instruct': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'meta/llama-3.1-405b-instruct': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
  'meta/llama-3.1-8b-instruct': { input: 0, output: 0, note: 'NIM hosted — gratis (dev)' },
};

function pricingFor(model) {
  if (!model) return null;
  return PRICING[model] || null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Normalised usage of ONE entry, or null when the entry carries none.
 * Returns {inputTokens, outputTokens, cacheReadTokens,
 * cacheCreationTokens, model}.
 */
function usageOfEntry(entry) {
  if (!entry || entry.type !== 'assistant') return null;
  const raw = (entry.message && entry.message.usage) || entry.usage || null;
  if (!raw || typeof raw !== 'object') return null;
  const details = raw.prompt_tokens_details || {};
  const usage = {
    inputTokens: num(raw.input_tokens ?? raw.prompt_tokens),
    outputTokens: num(raw.output_tokens ?? raw.completion_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens ?? details.cached_tokens),
    cacheCreationTokens: num(raw.cache_creation_input_tokens ?? details.cache_creation_tokens),
    model: (entry.message && entry.message.model) || entry.model || '',
  };
  if (!usage.inputTokens && !usage.outputTokens && !usage.cacheReadTokens && !usage.cacheCreationTokens) {
    return null;
  }
  return usage;
}

/** Estimate USD cost for a token bundle on a model. Null = unpriced. */
function estimateCost({ inputTokens, outputTokens }, model) {
  const price = pricingFor(model);
  if (!price) return null;
  return (num(inputTokens) / 1e6) * price.input + (num(outputTokens) / 1e6) * price.output;
}

function emptyTotals() {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    totalTokens: 0, costUSD: 0, unpricedTokens: 0, pricedTurns: 0, unpricedTurns: 0,
  };
}

function addUsage(totals, usage) {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadTokens += usage.cacheReadTokens;
  totals.cacheCreationTokens += usage.cacheCreationTokens;
  totals.totalTokens += usage.inputTokens + usage.outputTokens;
  const cost = estimateCost(usage, usage.model);
  if (cost === null) {
    totals.unpricedTokens += usage.inputTokens + usage.outputTokens;
    totals.unpricedTurns += 1;
  } else {
    totals.costUSD += cost;
    totals.pricedTurns += 1;
  }
}

function countToolCalls(entry) {
  if (!entry) return 0;
  const content = entry.message && entry.message.content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'tool_use').length;
  }
  if (entry.message && Array.isArray(entry.message.tool_calls)) {
    return entry.message.tool_calls.length;
  }
  return entry.type === 'tool_use' ? 1 : 0;
}

function isUserTextEntry(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return false;
  const c = entry.message.content;
  if (typeof c === 'string') return c.length > 0;
  if (Array.isArray(c)) return c.some((b) => b && b.type === 'text');
  return false;
}

/**
 * Full summary of one session's entries.
 * turns: one row per assistant entry carrying usage (for the panel's
 * per-turn table), in recorded order.
 */
function summarizeEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const totals = emptyTotals();
  const byModel = {};
  const turns = [];
  let assistantTurns = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let firstAt = null;
  let lastAt = null;
  let provider = '';
  let sessionModel = '';

  const head = list.find((e) => e && e.type === 'session');
  if (head && head.meta) {
    provider = head.meta.provider || '';
    sessionModel = head.meta.model || '';
  }

  for (const e of list) {
    if (!e) continue;
    if (e.timestamp) {
      if (!firstAt || e.timestamp < firstAt) firstAt = e.timestamp;
      if (!lastAt || e.timestamp > lastAt) lastAt = e.timestamp;
    }
    if (!provider && e.provider) provider = e.provider;
    if (e.type === 'assistant') {
      assistantTurns += 1;
      toolCalls += countToolCalls(e);
      const usage = usageOfEntry(e);
      if (usage) {
        addUsage(totals, usage);
        const key = usage.model || sessionModel || '(model tidak tercatat)';
        if (!byModel[key]) byModel[key] = emptyTotals();
        addUsage(byModel[key], usage);
        turns.push({
          timestamp: e.timestamp || '',
          model: usage.model || sessionModel || '',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUSD: estimateCost(usage, usage.model || sessionModel),
        });
      }
    } else if (e.type === 'user') {
      if (isUserTextEntry(e)) userMessages += 1;
      const c = e.message && e.message.content;
      if (Array.isArray(c)) toolResults += c.filter((b) => b && b.type === 'tool_result').length;
    } else if (e.type === 'tool_use') {
      toolCalls += 1;
    } else if (e.type === 'tool_result') {
      toolResults += 1;
    }
  }

  const durationMs = firstAt && lastAt ? Math.max(0, Date.parse(lastAt) - Date.parse(firstAt)) : 0;
  return {
    provider, model: sessionModel,
    entries: list.length,
    userMessages, assistantTurns, toolCalls, toolResults,
    firstAt, lastAt, durationMs,
    ...totals,
    byModel, turns,
  };
}

/**
 * Aggregate summaries of many sessions (each {id, createdAt, cwd,
 * provider, model, summary}) into one overview for the panel header.
 * Per-session identity fields pass through untouched.
 */
function summarizeSessions(sessionSummaries) {
  const list = Array.isArray(sessionSummaries) ? sessionSummaries : [];
  const totals = emptyTotals();
  const byModel = {};
  let userMessages = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  for (const s of list) {
    const sum = s && s.summary ? s.summary : null;
    if (!sum) continue;
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'unpricedTokens', 'pricedTurns', 'unpricedTurns']) {
      totals[k] += num(sum[k]);
    }
    totals.costUSD += num(sum.costUSD);
    userMessages += num(sum.userMessages);
    assistantTurns += num(sum.assistantTurns);
    toolCalls += num(sum.toolCalls);
    for (const [model, m] of Object.entries(sum.byModel || {})) {
      if (!byModel[model]) byModel[model] = emptyTotals();
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'unpricedTokens', 'pricedTurns', 'unpricedTurns']) {
        byModel[model][k] += num(m[k]);
      }
      byModel[model].costUSD += num(m.costUSD);
    }
  }
  return { sessions: list.length, userMessages, assistantTurns, toolCalls, ...totals, byModel };
}

/* ------------------------- formatting ------------------------------ */

function formatTokens(n) {
  const v = num(n);
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + ' rb';
  return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + ' jt';
}

function formatUSD(cost) {
  if (cost === null || cost === undefined) return '—';
  const v = Number(cost);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

function formatDuration(ms) {
  const v = num(ms);
  if (v < 1000) return v + ' md';
  const s = Math.round(v / 1000);
  if (s < 60) return s + ' dtk';
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? m + ' mnt ' + rest + ' dtk' : m + ' mnt';
  const h = Math.floor(m / 60);
  return h + ' jam ' + (m % 60) + ' mnt';
}

module.exports = {
  PRICING,
  pricingFor,
  usageOfEntry,
  estimateCost,
  summarizeEntries,
  summarizeSessions,
  formatTokens,
  formatUSD,
  formatDuration,
};

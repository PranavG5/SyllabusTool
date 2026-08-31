/**
 * Token pricing, so `usage_events.cost_usd` is a real number rather than a
 * placeholder. Rates are USD per 1M tokens on the first-party Claude API.
 *
 * If a model is not listed we fall back to the most expensive known rate:
 * over-reporting cost is a survivable bug, under-reporting it is not.
 */

export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
};

const FALLBACK_RATE: ModelRate = { inputPerMTok: 10, outputPerMTok: 50 };

/** Cache reads bill at ~0.1x the input rate; cache writes at ~1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rate = MODEL_RATES[model] ?? FALLBACK_RATE;
  const cost =
    (usage.inputTokens * rate.inputPerMTok +
      usage.outputTokens * rate.outputPerMTok +
      usage.cacheReadTokens * rate.inputPerMTok * CACHE_READ_MULTIPLIER +
      usage.cacheWriteTokens * rate.inputPerMTok * CACHE_WRITE_MULTIPLIER) /
    1_000_000;
  // usage_events.cost_usd is numeric(12,6).
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * memnant — Cost tracking for API calls.
 *
 * Hardcoded pricing table for known models.
 * Cost metadata is embedded in record content as a tagged line.
 */

export interface CostMetadata {
  tier: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// Pricing per million tokens (USD).
// Standard first-party Anthropic API rates, verified against
// platform.claude.com/docs/en/about-claude/pricing on 2026-08-24.
// Sonnet 5's $2/$10 launched as introductory pricing through 2026-08-31 and
// was since made standard; the scheduled rise to $3/$15 was cancelled.
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-fable-5': { input: 10.00, output: 50.00 },
  'claude-opus-5': { input: 5.00, output: 25.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00 },
  'claude-opus-4-6': { input: 5.00, output: 25.00 },
  'claude-sonnet-5': { input: 2.00, output: 10.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  // Dated aliases retained so historical cost tags stay parseable.
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
};

/**
 * Compute cost in USD for a given model and token counts.
 * Returns 0 for unknown models.
 */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Create a cost metadata object.
 */
export function formatCostMetadata(
  tier: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostMetadata {
  return {
    tier,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: computeCost(model, inputTokens, outputTokens),
  };
}

// Costs accrued since the last drain. callModel is the single funnel every LLM
// call passes through, but it has no ledger handle — it is a pure function over
// a tier config. So spend accumulates here and whoever owns a database drains it
// (see persistSessionCosts in ledger/sessions.ts, called at session close).
const pending: CostMetadata[] = [];

/**
 * Record what a completed model call cost. Called by callModel; unknown models
 * still record, at cost_usd 0, so an unpriced model shows up as a gap in the
 * pricing table rather than vanishing from the ledger entirely.
 */
export function recordCost(meta: CostMetadata): void {
  pending.push(meta);
}

/**
 * Take everything accrued since the last drain, clearing it. Draining twice
 * returns nothing the second time — a session cannot bill the same call twice.
 */
export function drainCosts(): CostMetadata[] {
  return pending.splice(0, pending.length);
}

/**
 * Serialize cost metadata as a tagged line for embedding in record content.
 */
export function serializeCostTag(meta: CostMetadata): string {
  return `\n[cost:${JSON.stringify(meta)}]`;
}

/**
 * Extract cost metadata from a record's content_text.
 */
export function parseCostFromRecord(contentText: string): CostMetadata | null {
  const match = contentText.match(/\[cost:(\{.+?\})\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as CostMetadata;
  } catch {
    return null;
  }
}

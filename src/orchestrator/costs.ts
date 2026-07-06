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

// Pricing per million tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
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

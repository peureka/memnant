/**
 * Tests for the output budget on background model calls.
 *
 * The analysis and triage tiers run unattended on every session close. On the
 * models they are now pinned to, thinking is on by default and its tokens are
 * drawn from the same max_tokens ceiling as the visible answer — so a ceiling
 * sized for a non-thinking model truncates the answer instead of the reasoning.
 * Pattern summarisation swallows that failure silently (synthesis/patterns.ts),
 * so nothing downstream would report it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async () => ({
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 10, output_tokens: 5 },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

describe('Background model call budget', () => {
  beforeEach(() => create.mockClear());

  async function requestFor(model: string): Promise<Record<string, any>> {
    const { callModel } = await import('../src/orchestrator/providers.js');
    await callModel({ provider: 'anthropic', model } as any, 'system', 'user');
    expect(create).toHaveBeenCalledOnce();
    return create.mock.calls[0]![0] as Record<string, any>;
  }

  it('leaves room for thinking as well as the answer', async () => {
    const request = await requestFor('claude-opus-5');

    // Banded rather than pinned to an exact constant: the behaviour is "enough
    // room for reasoning plus answer, but not an unbounded ceiling". An exact
    // assertion would test the constant; an open-ended one would let a 128k
    // ceiling through and quietly multiply worst-case cost and latency.
    expect(request.max_tokens).toBeGreaterThanOrEqual(16000);
    expect(request.max_tokens).toBeLessThanOrEqual(32000);
  });

  it('sends the triage tier nothing its model rejects', async () => {
    // Triage pins Haiku 4.5, the most restrictive model in use: it rejects
    // output_config.effort outright. callAnthropic builds one request shape for
    // every tier, so anything added for the benefit of the analysis tier lands
    // on Haiku too and 400s there first.
    const request = await requestFor('claude-haiku-4-5');

    expect(request.output_config?.effort).toBeUndefined();
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('top_p');
    expect(request).not.toHaveProperty('top_k');
  });
});

import { describe, it, expect } from 'vitest';
import { scoreRecord } from '../src/relevance/scoring.js';

describe('builder diversity scoring', () => {
  it('boosts score when builderConfirmations > 0', () => {
    const base = scoreRecord({
      similarity: 0.8,
      createdAt: new Date().toISOString(),
      isStale: false,
      accessCount: 0,
      isSuperseded: false,
    });

    const boosted = scoreRecord({
      similarity: 0.8,
      createdAt: new Date().toISOString(),
      isStale: false,
      accessCount: 0,
      isSuperseded: false,
      builderConfirmations: 3,
    });

    expect(boosted.relevance).toBeGreaterThan(base.relevance);
  });

  it('caps builder diversity boost at +0.15', () => {
    const boosted3 = scoreRecord({
      similarity: 0.8,
      createdAt: new Date().toISOString(),
      isStale: false,
      accessCount: 0,
      isSuperseded: false,
      builderConfirmations: 3,
    });

    const boosted10 = scoreRecord({
      similarity: 0.8,
      createdAt: new Date().toISOString(),
      isStale: false,
      accessCount: 0,
      isSuperseded: false,
      builderConfirmations: 10,
    });

    expect(boosted10.relevance).toBe(boosted3.relevance);
  });

  it('includes builder_diversity in signals when present', () => {
    const result = scoreRecord({
      similarity: 0.8,
      createdAt: new Date().toISOString(),
      isStale: false,
      accessCount: 0,
      isSuperseded: false,
      builderConfirmations: 2,
    });

    expect(result.signals.builder_diversity).toBeDefined();
    expect(result.signals.builder_diversity!.confirmations).toBe(2);
    expect(result.signals.builder_diversity!.boost).toBe(0.1);
  });

  it('does not include builder_diversity when no confirmations', () => {
    const result = scoreRecord({
      similarity: 0.8,
      createdAt: new Date().toISOString(),
      isStale: false,
      accessCount: 0,
      isSuperseded: false,
    });

    expect(result.signals.builder_diversity).toBeUndefined();
  });
});

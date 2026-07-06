/**
 * Tests for Semantic Staleness.
 */

import { describe, it, expect } from 'vitest';
import { scoreRecord, type ScoreInputs } from '../src/relevance/scoring.js';
import { computeSemanticStaleness } from '../src/context/compile.js';

describe('Semantic Staleness — Gradient Freshness', () => {
  const baseInputs: ScoreInputs = {
    similarity: 0.8,
    createdAt: new Date().toISOString(),
    isStale: false,
    stalenessConfidence: 0,
    accessCount: 5,
    isSuperseded: false,
  };

  it('freshness is 1.0 when not stale (confidence 0)', () => {
    const result = scoreRecord(baseInputs);
    expect(result.signals.freshness.raw).toBe(1.0);
  });

  it('freshness drops with staleness confidence', () => {
    const result = scoreRecord({ ...baseInputs, isStale: true, stalenessConfidence: 0.5 });
    // freshness = 1.0 - (0.8 * 0.5) = 0.6
    expect(result.signals.freshness.raw).toBeCloseTo(0.6, 2);
  });

  it('freshness floors at 0.2 when confidence is 1.0', () => {
    const result = scoreRecord({ ...baseInputs, isStale: true, stalenessConfidence: 1.0 });
    // freshness = 1.0 - (0.8 * 1.0) = 0.2
    expect(result.signals.freshness.raw).toBeCloseTo(0.2, 2);
  });

  it('backward compatible: isStale with no confidence uses 1.0', () => {
    const { stalenessConfidence: _, ...inputsWithoutConfidence } = baseInputs;
    const result = scoreRecord({ ...inputsWithoutConfidence, isStale: true });
    // No stalenessConfidence provided → defaults to 1.0 → freshness = 0.2
    expect(result.signals.freshness.raw).toBeCloseTo(0.2, 2);
  });
});

describe('Semantic Staleness — Diff Embedding Matching', () => {
  it('computeSemanticStaleness returns confidence scores', () => {
    const mockStaleCandidates = new Map<string, string[]>();
    mockStaleCandidates.set('record-1', ['src/auth.ts']);

    const mockRecordEmbeddings = new Map<string, Float32Array>();
    mockRecordEmbeddings.set('record-1', new Float32Array(384).fill(0.1));

    const mockDiffEmbeddings = new Map<string, Float32Array>();
    mockDiffEmbeddings.set('src/auth.ts', new Float32Array(384).fill(0.1));

    const result = computeSemanticStaleness(mockStaleCandidates, mockRecordEmbeddings, mockDiffEmbeddings);
    expect(result).toBeInstanceOf(Map);
    expect(result.has('record-1')).toBe(true);
    // Same embedding → similarity ~1.0 → capped confidence 1.0
    expect(result.get('record-1')).toBeGreaterThan(0.35);
  });

  it('returns 0 confidence when diff is semantically unrelated', () => {
    const mockStaleCandidates = new Map<string, string[]>();
    mockStaleCandidates.set('record-1', ['src/auth.ts']);

    // Orthogonal embeddings → similarity near 0
    const recordEmb = new Float32Array(384);
    recordEmb[0] = 1.0;
    const diffEmb = new Float32Array(384);
    diffEmb[1] = 1.0;

    const mockRecordEmbeddings = new Map<string, Float32Array>();
    mockRecordEmbeddings.set('record-1', recordEmb);

    const mockDiffEmbeddings = new Map<string, Float32Array>();
    mockDiffEmbeddings.set('src/auth.ts', diffEmb);

    const result = computeSemanticStaleness(mockStaleCandidates, mockRecordEmbeddings, mockDiffEmbeddings);
    expect(result.has('record-1')).toBe(false); // Below threshold, not included
  });
});

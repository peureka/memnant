/**
 * memnant — Composite relevance scoring.
 *
 * Story 10.1: Four signals combined with configurable weights.
 * 1. Similarity (0.4) — from vector search
 * 2. Recency (0.25) — exponential decay with configurable half-life
 * 3. Freshness (0.2) — 1.0 if not stale, 0.2 if stale
 * 4. Frequency (0.15) — normalized access count (sigmoid, caps ~10)
 *
 * Superseded records get 0.5x multiplier.
 */

import { getHalfLifeDays } from './profiles.js';

export interface RelevanceWeights {
  similarity: number;
  recency: number;
  freshness: number;
  frequency: number;
}

export const DEFAULT_WEIGHTS: RelevanceWeights = {
  similarity: 0.4,
  recency: 0.25,
  freshness: 0.2,
  frequency: 0.15,
};

export interface ScoredRecord {
  id: string;
  type: string;
  content_text: string;
  created_at: string;
  tags: string[];
  related_records: string[];
  similarity: number;
  stale_embedding: boolean;
  relevance: number;
  is_stale: boolean;
  is_superseded: boolean;
  has_newer_version?: boolean;
  signals?: RelevanceSignals;
}

export interface ScoreInputs {
  similarity: number;
  createdAt: string;
  isStale: boolean;
  stalenessConfidence?: number;
  accessCount: number;
  isSuperseded: boolean;
  builderConfirmations?: number;  // Distinct builders with similar records
  coOccurrenceBoost?: number;     // Trail boost from co-occurrence patterns
}

export interface SignalDetail {
  raw: number;
  weight: number;
  weighted: number;
}

export interface RelevanceSignals {
  similarity: SignalDetail;
  recency: SignalDetail;
  freshness: SignalDetail & { staleness_confidence?: number };
  frequency: SignalDetail;
  builder_diversity?: { confirmations: number; boost: number };
  co_occurrence?: { boost: number };
}

export interface ScoreResult {
  relevance: number;
  signals: RelevanceSignals;
}

/**
 * Compute a composite relevance score for a record.
 */
export function scoreRecord(
  inputs: ScoreInputs,
  weights: RelevanceWeights = DEFAULT_WEIGHTS,
  decayProfile: string = 'default',
): ScoreResult {
  const halfLifeDays = getHalfLifeDays(decayProfile);

  // 1. Similarity — as-is
  const similarityScore = inputs.similarity;

  // 2. Recency — exponential decay
  const ageMs = Date.now() - new Date(inputs.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = Math.pow(0.5, ageDays / halfLifeDays);

  // 3. Freshness — gradient based on staleness confidence
  const confidence = inputs.isStale ? (inputs.stalenessConfidence ?? 1.0) : 0;
  const freshnessScore = 1.0 - (0.8 * confidence);

  // 4. Frequency — sigmoid normalization, caps around 10 accesses
  const frequencyScore = sigmoid(inputs.accessCount, 5, 1);

  // Weighted sum
  let score = (
    weights.similarity * similarityScore +
    weights.recency * recencyScore +
    weights.freshness * freshnessScore +
    weights.frequency * frequencyScore
  );

  // Builder diversity boost: +0.05 per additional builder, capped at +0.15
  let diversityBoost = 0;
  if (inputs.builderConfirmations && inputs.builderConfirmations > 0) {
    diversityBoost = Math.min(inputs.builderConfirmations * 0.05, 0.15);
    score += diversityBoost;
  }

  // Co-occurrence trail boost
  let trailBoost = 0;
  if (inputs.coOccurrenceBoost && inputs.coOccurrenceBoost > 0) {
    trailBoost = Math.min(inputs.coOccurrenceBoost, 0.2);
    score += trailBoost;
  }

  // Superseded penalty
  if (inputs.isSuperseded) {
    score *= 0.5;
  }

  const relevance = Math.round(score * 1000) / 1000;

  const signals: RelevanceSignals = {
    similarity: {
      raw: similarityScore,
      weight: weights.similarity,
      weighted: Math.round(weights.similarity * similarityScore * 1000) / 1000,
    },
    recency: {
      raw: Math.round(recencyScore * 1000) / 1000,
      weight: weights.recency,
      weighted: Math.round(weights.recency * recencyScore * 1000) / 1000,
    },
    freshness: {
      raw: freshnessScore,
      weight: weights.freshness,
      weighted: Math.round(weights.freshness * freshnessScore * 1000) / 1000,
      staleness_confidence: inputs.isStale ? (inputs.stalenessConfidence ?? 1.0) : undefined,
    },
    frequency: {
      raw: Math.round(frequencyScore * 1000) / 1000,
      weight: weights.frequency,
      weighted: Math.round(weights.frequency * frequencyScore * 1000) / 1000,
    },
    ...(inputs.builderConfirmations ? {
      builder_diversity: {
        confirmations: inputs.builderConfirmations,
        boost: Math.round(diversityBoost * 1000) / 1000,
      },
    } : {}),
    ...(inputs.coOccurrenceBoost ? {
      co_occurrence: {
        boost: Math.round(trailBoost * 1000) / 1000,
      },
    } : {}),
  };

  return { relevance, signals };
}

/**
 * Sigmoid function for normalizing access count.
 * midpoint: x value where output is 0.5
 * steepness: how quickly it approaches 1
 */
function sigmoid(x: number, midpoint: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (x - midpoint)));
}

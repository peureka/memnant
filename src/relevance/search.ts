/**
 * memnant — Relevance-aware search wrapper.
 *
 * Story 10.1: Wraps raw vector search with composite relevance scoring.
 * The raw searchRecords() stays unchanged — still used by auto-linking.
 */

import type { Database } from '../ledger/database.js';
import type { RecordType, ProjectConfig } from '../types.js';
import type { RecallResult } from '../vector/search.js';
import { searchRecords } from '../vector/search.js';
import { computeStaleRecordIds, computeAstStaleRecordIds } from '../context/compile.js';
import { getSupersededRecordIds } from '../graph/relationships.js';
import { getAccessCounts } from './access.js';
import { scoreRecord, DEFAULT_WEIGHTS, type ScoredRecord, type RelevanceWeights } from './scoring.js';
import { getCoOccurrenceBoosts } from '../context/patterns.js';

export interface RelevanceSearchOptions {
  type?: RecordType;
  since?: string;
  limit: number;
  projectRoot?: string;
  noDecay?: boolean;
  decayProfile?: string;
  weights?: RelevanceWeights;
  explain?: boolean;
  includeRetracted?: boolean;
  includeArchived?: boolean;
  builder?: string;
}

/**
 * Search records with composite relevance scoring.
 * Includes both file-hash and AST-anchored staleness detection.
 */
export async function relevanceSearch(
  db: Database,
  queryEmbedding: Float32Array,
  options: RelevanceSearchOptions,
): Promise<ScoredRecord[]> {
  // Raw vector search with generous limit to get candidates
  const rawResults = searchRecords(db, queryEmbedding, {
    type: options.type,
    since: options.since,
    limit: Math.max(options.limit * 3, 50), // Over-fetch for re-ranking
    includeRetracted: options.includeRetracted,
    includeArchived: options.includeArchived,
  });

  if (rawResults.length === 0) return [];

  // Filter by builder if requested
  let filtered = rawResults;
  if (options.builder) {
    const builderMap = new Map<string, string | null>();
    for (const r of rawResults) {
      const row = db.get('SELECT builder_id FROM record WHERE id = ?', [r.id]) as any;
      builderMap.set(r.id, row?.builder_id ?? null);
    }
    filtered = rawResults.filter(r => builderMap.get(r.id) === options.builder);
  }

  if (filtered.length === 0) return [];

  // If noDecay, return raw results as-is
  if (options.noDecay) {
    return filtered.slice(0, options.limit).map((r) => ({
      ...r,
      relevance: r.similarity,
      is_stale: false,
      is_superseded: false,
    }));
  }

  // Gather scoring context — combine file-hash and AST-anchored staleness
  const staleMap = options.projectRoot
    ? await computeStaleRecordIds(db, options.projectRoot)
    : new Map<string, number>();

  if (options.projectRoot) {
    const astStaleIds = await computeAstStaleRecordIds(db, options.projectRoot);
    for (const id of astStaleIds) {
      staleMap.set(id, 1.0); // AST staleness is binary: confidence = 1.0
    }
  }
  const supersededIds = getSupersededRecordIds(db);

  // Find records that have newer versions
  const hasNewerVersionIds = new Set<string>(
    (db.all(
      "SELECT target_record_id as id FROM record_relationship WHERE type = 'version_of' AND dismissed_at IS NULL"
    ) as any[]).map((r: any) => r.id)
  );

  const recordIds = filtered.map((r) => r.id);
  const accessCounts = getAccessCounts(db, recordIds);

  // Compute builder diversity
  const builderConfirmationsMap = new Map<string, number>();
  const buildersExist = db.get('SELECT 1 FROM record WHERE builder_id IS NOT NULL LIMIT 1');
  if (buildersExist) {
    for (const r of filtered) {
      const row = db.get(
        `SELECT COUNT(DISTINCT r2.builder_id) as cnt
         FROM record_relationship rr
         JOIN record r2 ON (
           (rr.target_record_id = r2.id AND rr.source_record_id = ?)
           OR (rr.source_record_id = r2.id AND rr.target_record_id = ?)
         )
         WHERE rr.type = 'related' AND rr.dismissed_at IS NULL
           AND r2.builder_id IS NOT NULL`,
        [r.id, r.id]
      ) as any;
      const cnt = (row?.cnt ?? 0);
      // Subtract 1 because we want "additional" builders beyond the record's own builder
      if (cnt > 1) {
        builderConfirmationsMap.set(r.id, cnt - 1);
      }
    }
  }

  const coOccurrenceBoosts = getCoOccurrenceBoosts(db, recordIds);

  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const decayProfile = options.decayProfile ?? 'default';

  // Score each result
  const scored: ScoredRecord[] = filtered.map((r) => {
    const isStale = staleMap.has(r.id);
    const stalenessConfidence = staleMap.get(r.id) ?? 0;
    const isSuperseded = supersededIds.has(r.id);
    const accessCount = accessCounts.get(r.id) ?? 0;

    const scoreResult = scoreRecord(
      {
        similarity: r.similarity,
        createdAt: r.created_at,
        isStale,
        stalenessConfidence,
        accessCount,
        isSuperseded,
        builderConfirmations: builderConfirmationsMap.get(r.id),
        coOccurrenceBoost: coOccurrenceBoosts.get(r.id),
      },
      weights,
      decayProfile,
    );

    return {
      ...r,
      relevance: scoreResult.relevance,
      is_stale: isStale,
      is_superseded: isSuperseded,
      has_newer_version: hasNewerVersionIds.has(r.id),
      ...(options.explain ? { signals: scoreResult.signals } : {}),
    };
  });

  // Sort by relevance, take limit
  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.slice(0, options.limit);
}

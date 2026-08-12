/**
 * writeCandidate — the shared integrity write for candidate knowledge.
 *
 * Product invariant: the source of a candidate must not determine the
 * integrity of the resulting ledger record. Every ingestion path (transcript
 * harvest, observe, interchange/portable/NotebookLM import, memnant log)
 * converges here once a candidate has been accepted for writing:
 *
 *   embedding → insertRecord → auto-link/supersede → contradiction detection
 *
 * Deduplication stays with the caller — it is batch-shaped and legitimately
 * differs per source. Graph processing is best-effort: the record write
 * itself must never be lost to a linking or model failure.
 */

import type { Database } from './database.js';
import type { ProjectConfig, Record, TierConfig } from '../types.js';
import { insertRecord, type InsertRecordParams } from './records.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { serializeEmbedding } from '../vector/embedding-utils.js';
import { autoLinkRecord, detectContradictions, type Relationship } from '../graph/relationships.js';

export type CallModelFn = (
  tier: TierConfig,
  system: string,
  user: string,
) => Promise<{ text: string }>;

export interface WriteCandidateOptions {
  /** Project config — enables contradiction detection when a triage tier is configured. */
  config?: ProjectConfig;
  /** Injectable model call (tests); defaults to the orchestrator's callModel. */
  callModelFn?: CallModelFn;
}

export interface WriteCandidateResult {
  record: Record;
  /** related / supersedes links created by auto-linking. */
  relationships: Relationship[];
  /** contradicts links created by contradiction detection. */
  contradictions: Relationship[];
}

/** InsertRecordParams with the embedding optional — generated when absent. */
export type WriteCandidateParams = Omit<InsertRecordParams, 'embedding'> & {
  embedding?: Buffer | Uint8Array;
};

export async function writeCandidate(
  db: Database,
  params: WriteCandidateParams,
  options?: WriteCandidateOptions,
): Promise<WriteCandidateResult> {
  const embedding =
    params.embedding ?? serializeEmbedding(await generateEmbedding(params.contentText));

  const record = insertRecord(db, { ...params, embedding });

  let relationships: Relationship[] = [];
  try {
    relationships = autoLinkRecord(db, record, options?.config);
  } catch {
    // Best-effort — the record is already written.
  }

  let contradictions: Relationship[] = [];
  if (options?.config?.orchestrator?.tiers?.triage) {
    try {
      const callModelFn =
        options.callModelFn ?? (await import('../orchestrator/providers.js')).callModel;
      contradictions = await detectContradictions(db, record, options.config, callModelFn);
    } catch {
      // No API key, network failure — the write still succeeds.
    }
  }

  return { record, relationships, contradictions };
}

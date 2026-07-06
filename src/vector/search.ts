/**
 * memnant — Vector search over the ledger.
 *
 * Story 1.3: Brute-force cosine similarity search using dot product on
 * normalized embeddings. SQL pre-filters by type and date before computing
 * similarity in-memory. Correct for the 500-record target (~750 KB of embeddings).
 */

import type { Database } from '../ledger/database.js';
import type { RecordType } from '../types.js';
import { deserializeEmbedding, MODEL_NAME } from './embedding-utils.js';

const MIN_SIMILARITY_THRESHOLD = 0.3;

export interface RecallFilters {
  type?: RecordType;
  since?: string;
  limit: number;
  includeRetracted?: boolean;
  includeArchived?: boolean;
}

export interface RecallResult {
  id: string;
  type: string;
  content_text: string;
  created_at: string;
  tags: string[];
  related_records: string[];
  similarity: number;
  stale_embedding: boolean;
}

interface CandidateRow {
  id: string;
  type: string;
  content_text: string;
  created_at: string;
  tags: string;
  related_records: string;
  embedding: Uint8Array;
  embedding_model: string;
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

export function searchRecords(
  db: Database,
  queryEmbedding: Float32Array,
  filters: RecallFilters,
): RecallResult[] {
  const conditions = ['embedding IS NOT NULL'];
  const params: (string | number)[] = [];

  if (!filters.includeRetracted) {
    conditions.push('retracted_at IS NULL');
  }
  if (!filters.includeArchived) {
    conditions.push('archived_at IS NULL');
  }

  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }

  if (filters.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const sql = `SELECT id, type, content_text, created_at, tags, related_records, embedding, embedding_model
    FROM record
    WHERE ${conditions.join(' AND ')}`;

  const rows = db.all(sql, params) as unknown as CandidateRow[];

  const scored: RecallResult[] = [];
  for (const row of rows) {
    const rowEmbedding = deserializeEmbedding(row.embedding);
    const similarity = dotProduct(queryEmbedding, rowEmbedding);

    if (similarity >= MIN_SIMILARITY_THRESHOLD) {
      scored.push({
        id: row.id,
        type: row.type,
        content_text: row.content_text,
        created_at: row.created_at,
        tags: JSON.parse(row.tags),
        related_records: JSON.parse(row.related_records),
        similarity,
        stale_embedding: row.embedding_model !== MODEL_NAME,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, filters.limit);
}

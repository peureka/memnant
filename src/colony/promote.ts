/**
 * Colony promotion — copies records from project ledgers to the colony.
 *
 * Auto-promotes framework_fix and rejected decisions. Deduplicates
 * by embedding similarity (>0.92 = duplicate, increment confirmation).
 */

import type { Record } from '../types.js';
import { serializeEmbedding, deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';
import { v4 as uuid } from 'uuid';

const DEDUP_THRESHOLD = 0.92;

export function findDuplicate(colonyDb: any, embedding: Float32Array, threshold?: number): string | null {
  const t = threshold ?? DEDUP_THRESHOLD;
  const rows = colonyDb.all(
    "SELECT id, embedding FROM record WHERE embedding IS NOT NULL AND retracted_at IS NULL AND archived_at IS NULL"
  );

  for (const row of rows) {
    const existing = deserializeEmbedding(row.embedding);
    const sim = dotProduct(embedding, existing);
    if (sim >= t) return row.id;
  }
  return null;
}

export function isDuplicate(colonyDb: any, embedding: Float32Array, threshold?: number): boolean {
  return findDuplicate(colonyDb, embedding, threshold) !== null;
}

export function incrementConfirmation(db: any, colonyRecordId: string): void {
  db.run(
    'UPDATE record SET confirmation_count = confirmation_count + 1 WHERE id = ?',
    [colonyRecordId],
  );
}

export async function promoteToColony(
  colonyDb: any,
  record: Record,
  sourceProjectId: string,
): Promise<{ id: string; source_project_id: string; source_record_id: string } | null> {
  if (!record.embedding) return null;

  // Check for duplicate — increment confirmation instead of silently skipping
  const duplicateId = findDuplicate(colonyDb, record.embedding);
  if (duplicateId) {
    incrementConfirmation(colonyDb, duplicateId);
    return null;
  }

  const id = uuid();
  const now = new Date().toISOString();
  const embeddingBuffer = serializeEmbedding(record.embedding);

  colonyDb.run(
    `INSERT INTO record (id, project_id, type, content, content_text, embedding, tags, related_records, created_at, source_project_id, source_record_id, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      'colony',
      record.type,
      JSON.stringify(record.content),
      record.content_text,
      embeddingBuffer,
      JSON.stringify(record.tags),
      JSON.stringify([]),
      now,
      sourceProjectId,
      record.id,
      record.embedding_model ?? null,
    ]
  );

  return { id, source_project_id: sourceProjectId, source_record_id: record.id };
}

export function shouldAutoPromote(type: string, tags: string[]): boolean {
  if (type === 'framework_fix') return true;
  if (type === 'decision' && tags.includes('rejected')) return true;
  return false;
}

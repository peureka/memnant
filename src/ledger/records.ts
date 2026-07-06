/**
 * memnant — Record insertion.
 *
 * Story 1.2: Thin database layer for writing records to the ledger.
 * Records are immutable after creation — there is no update function.
 */

import type { Database } from './database.js';
import { v4 as uuidv4 } from 'uuid';
import type { Record, RecordType } from '../types.js';
import { RECORD_TYPES } from '../types.js';
import { deserializeEmbedding, MODEL_NAME } from '../vector/embedding-utils.js';

export interface InsertRecordParams {
  projectId: string;
  type: RecordType;
  contentText: string;
  tags?: string[];
  relatedRecords?: string[];
  embedding: Buffer | Uint8Array;
  sourceSession?: string | null;
  targetFile?: string | null;
  targetSymbol?: string | null;
  astHash?: string | null;
  embeddingModel?: string;
  assumptions?: string[] | null;
  builderId?: string | null;
}

export function insertRecord(db: Database, params: InsertRecordParams): Record {
  if (!params.projectId) throw new Error('projectId is required');
  if (!params.contentText) throw new Error('contentText is required');
  if (!(RECORD_TYPES as readonly string[]).includes(params.type)) {
    throw new Error(`Invalid record type '${params.type}'. Valid types: ${RECORD_TYPES.join(', ')}`);
  }

  const id = uuidv4();
  const createdAt = new Date().toISOString();
  const content = JSON.stringify({ text: params.contentText });
  const tags = JSON.stringify(params.tags ?? []);
  const relatedRecords = JSON.stringify(params.relatedRecords ?? []);

  db.run(
    `INSERT INTO record (id, project_id, type, content, content_text, embedding, tags, related_records, created_at, source_session, target_file, target_symbol, ast_hash, embedding_model, assumptions, builder_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.projectId,
      params.type,
      content,
      params.contentText,
      params.embedding,
      tags,
      relatedRecords,
      createdAt,
      params.sourceSession ?? null,
      params.targetFile ?? null,
      params.targetSymbol ?? null,
      params.astHash ?? null,
      params.embeddingModel ?? MODEL_NAME,
      params.assumptions ? JSON.stringify(params.assumptions) : null,
      params.builderId ?? null,
    ],
  );

  const record: Record = {
    id,
    project_id: params.projectId,
    type: params.type,
    content: { text: params.contentText },
    content_text: params.contentText,
    tags: params.tags ?? [],
    related_records: params.relatedRecords ?? [],
    created_at: createdAt,
    source_session: params.sourceSession ?? null,
    staleness_marker: null,
    retracted_at: null,
    retracted_reason: null,
    archived_at: null,
    target_file: params.targetFile ?? null,
    target_symbol: params.targetSymbol ?? null,
    ast_hash: params.astHash ?? null,
    embedding_model: params.embeddingModel ?? MODEL_NAME,
    assumptions: params.assumptions ?? null,
    builder_id: params.builderId ?? null,
  };

  // Attach embedding for auto-linking (Epic 9)
  if (params.embedding) {
    record.embedding = params.embedding instanceof Float32Array
      ? params.embedding
      : deserializeEmbedding(params.embedding);
  }

  return record;
}

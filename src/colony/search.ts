/**
 * Colony search — searches the colony ledger and marks results.
 */

import { deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';

const MIN_SIMILARITY = 0.3;

export interface ColonySearchResult {
  id: string;
  type: string;
  content_text: string;
  similarity: number;
  created_at: string;
  tags: string[];
  source: 'colony';
  source_project_id: string | null;
  source_record_id: string | null;
}

export function searchColony(
  colonyDb: any,
  queryEmbedding: Float32Array,
  options: { limit?: number; type?: string },
): ColonySearchResult[] {
  let sql = `SELECT id, type, content_text, embedding, created_at, tags, source_project_id, source_record_id
    FROM record
    WHERE embedding IS NOT NULL AND retracted_at IS NULL AND archived_at IS NULL`;
  const params: any[] = [];

  if (options.type) {
    sql += ' AND type = ?';
    params.push(options.type);
  }

  const rows = colonyDb.all(sql, params);
  const scored: ColonySearchResult[] = [];

  for (const row of rows) {
    const embedding = deserializeEmbedding(row.embedding);
    const similarity = dotProduct(queryEmbedding, embedding);
    if (similarity < MIN_SIMILARITY) continue;

    scored.push({
      id: row.id,
      type: row.type,
      content_text: row.content_text,
      similarity,
      created_at: row.created_at,
      tags: JSON.parse(row.tags || '[]'),
      source: 'colony',
      source_project_id: row.source_project_id,
      source_record_id: row.source_record_id,
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, options.limit ?? 5);
}

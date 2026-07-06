/**
 * memnant — Embedding reindex.
 *
 * Regenerates embeddings for records whose embedding_model
 * doesn't match the current MODEL_NAME.
 */

import type { Database } from '../ledger/database.js';
import { generateEmbedding, serializeEmbedding, MODEL_NAME } from './embeddings.js';

export interface ReindexOptions {
  staleOnly: boolean;
  dryRun: boolean;
  onProgress?: (current: number, total: number) => void;
}

export interface ReindexResult {
  total: number;
  reindexed: number;
  records?: Array<{ id: string; oldModel: string }>;
}

export async function reindexRecords(
  db: Database,
  options: ReindexOptions,
): Promise<ReindexResult> {
  const condition = options.staleOnly
    ? 'WHERE embedding IS NOT NULL AND embedding_model != ?'
    : 'WHERE embedding IS NOT NULL';
  const params = options.staleOnly ? [MODEL_NAME] : [];

  const rows = db.all(
    `SELECT id, content_text, embedding_model FROM record ${condition}`,
    params,
  ) as unknown as Array<{ id: string; content_text: string; embedding_model: string }>;

  const total = rows.length;

  if (options.dryRun) {
    return {
      total,
      reindexed: 0,
      records: rows.map((r) => ({ id: r.id, oldModel: r.embedding_model })),
    };
  }

  let reindexed = 0;
  for (const row of rows) {
    const embedding = await generateEmbedding(row.content_text);
    const buffer = serializeEmbedding(embedding);

    db.run(
      'UPDATE record SET embedding = ?, embedding_model = ? WHERE id = ?',
      [buffer, MODEL_NAME, row.id],
    );

    reindexed++;
    options.onProgress?.(reindexed, total);
  }

  return { total, reindexed };
}

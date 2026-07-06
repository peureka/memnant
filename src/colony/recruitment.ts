/**
 * memnant — Recruitment: proactive colony pattern surfacing.
 * Colony records confirmed by 3+ projects surface unprompted.
 */

import { deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';

const RECRUITMENT_SIMILARITY = 0.3;

export interface RecruitablePattern {
  id: string;
  type: string;
  content_text: string;
  confirmation_count: number;
  similarity: number;
}

export function findRecruitablePatterns(
  colonyDb: any,
  topicEmbedding: Float32Array,
  minConfirmations: number = 3,
  limit: number = 3,
): RecruitablePattern[] {
  const rows = colonyDb.all(
    `SELECT id, type, content_text, embedding, confirmation_count
     FROM record
     WHERE embedding IS NOT NULL
       AND retracted_at IS NULL
       AND archived_at IS NULL
       AND confirmation_count >= ?`,
    [minConfirmations],
  );

  const results: RecruitablePattern[] = [];

  for (const row of rows) {
    const embedding = deserializeEmbedding(row.embedding);
    const similarity = dotProduct(topicEmbedding, embedding);
    if (similarity < RECRUITMENT_SIMILARITY) continue;

    results.push({
      id: row.id,
      type: row.type,
      content_text: row.content_text,
      confirmation_count: row.confirmation_count,
      similarity,
    });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

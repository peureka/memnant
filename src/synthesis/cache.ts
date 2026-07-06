/**
 * memnant — Synthesis cache management.
 *
 * Story 11.3: Cache synthesis results as synthesis_cache records with TTL.
 */

import type { Database } from '../ledger/database.js';
import { insertRecord } from '../ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../vector/embeddings.js';

const CACHE_TTL_HOURS = 24;

export interface CachedSynthesis {
  id: string;
  topic: string;
  synthesis: string;
  created_at: string;
  is_expired: boolean;
}

/**
 * Get cached syntheses that are still valid.
 */
export function getCachedSyntheses(db: Database): CachedSynthesis[] {
  const rows = db.all(
    "SELECT id, content_text, created_at FROM record WHERE type = 'synthesis_cache' AND retracted_at IS NULL ORDER BY created_at DESC",
  ) as unknown as Array<{ id: string; content_text: string; created_at: string }>;

  const now = Date.now();

  return rows.map((row) => {
    const ageMs = now - new Date(row.created_at).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    // Parse topic from content (first line)
    const lines = row.content_text.split('\n');
    const topic = lines[0].replace(/^#+\s*/, '').trim();
    const synthesis = lines.slice(1).join('\n').trim();

    return {
      id: row.id,
      topic,
      synthesis,
      created_at: row.created_at,
      is_expired: ageHours > CACHE_TTL_HOURS,
    };
  });
}

/**
 * Get valid (non-expired) cached syntheses.
 */
export function getValidSyntheses(db: Database): CachedSynthesis[] {
  return getCachedSyntheses(db).filter((s) => !s.is_expired);
}

/**
 * Cache a synthesis result.
 */
export async function cacheSynthesis(
  db: Database,
  projectId: string,
  topic: string,
  synthesis: string,
): Promise<string> {
  const content = `# ${topic}\n${synthesis}`;
  const embedding = await generateEmbedding(content);
  const embeddingBuffer = serializeEmbedding(embedding);

  const record = insertRecord(db, {
    projectId,
    type: 'synthesis_cache',
    contentText: content,
    tags: ['synthesis', 'cache'],
    embedding: embeddingBuffer,
  });

  return record.id;
}

/**
 * Clean up expired synthesis cache entries.
 */
export function pruneExpiredSyntheses(db: Database): number {
  const cutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  const expired = db.all(
    "SELECT id FROM record WHERE type = 'synthesis_cache' AND retracted_at IS NULL AND created_at < ?",
    [cutoff],
  ) as unknown as Array<{ id: string }>;

  for (const row of expired) {
    db.run('DELETE FROM record WHERE id = ?', [row.id]);
  }

  return expired.length;
}

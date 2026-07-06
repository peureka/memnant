/**
 * memnant — File-aware context.
 *
 * Story 12.1: Given a file path, return relevant records.
 * Search approach: SQL LIKE for path mentions + semantic search on filename.
 */

import type { Database } from '../ledger/database.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { relevanceSearch, type RelevanceSearchOptions } from '../relevance/search.js';
import { trackAccess } from '../relevance/access.js';
import type { ScoredRecord } from '../relevance/scoring.js';

export interface FileContextResult {
  file: string;
  records: ScoredRecord[];
  mention_records: Array<{
    id: string;
    short_id: string;
    type: string;
    content_preview: string;
  }>;
}

/**
 * Get records relevant to a specific file path.
 */
export async function getContextForFile(
  db: Database,
  filePath: string,
  options?: {
    projectRoot?: string;
    limit?: number;
    decayProfile?: string;
  },
): Promise<FileContextResult> {
  const limit = options?.limit ?? 10;

  // 1. SQL LIKE search for path mentions in content_text
  const mentionRows = db.all(
    `SELECT id, type, content_text FROM record
     WHERE content_text LIKE ? AND type IN ('decision', 'framework_fix')
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT ?`,
    [`%${filePath}%`, limit],
  ) as unknown as Array<{ id: string; type: string; content_text: string }>;

  const mentionRecords = mentionRows.map((r) => ({
    id: r.id,
    short_id: r.id.slice(0, 8),
    type: r.type,
    content_preview: r.content_text.split('\n')[0].slice(0, 200),
  }));

  // 2. Semantic search using the file path as query
  const queryEmbedding = await generateEmbedding(filePath);
  const semanticResults = await relevanceSearch(db, queryEmbedding, {
    limit,
    projectRoot: options?.projectRoot,
    decayProfile: options?.decayProfile,
  });

  // 3. Merge and deduplicate
  const mentionIds = new Set(mentionRows.map((r) => r.id));
  const uniqueSemanticResults = semanticResults.filter((r) => !mentionIds.has(r.id));
  const allResults = [...semanticResults.filter((r) => mentionIds.has(r.id)), ...uniqueSemanticResults].slice(0, limit);

  // Track access
  if (allResults.length > 0) {
    trackAccess(db, allResults.map((r) => r.id), `file_context:${filePath}`);
  }

  return {
    file: filePath,
    records: allResults,
    mention_records: mentionRecords,
  };
}

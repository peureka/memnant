/**
 * Review pressure — flags old decisions that may need revisiting.
 *
 * Decisions older than a configurable threshold that haven't been
 * accessed within that period get flagged for review. Distinct from
 * staleness (code-driven) — this is purely time-based.
 */

import type { Database } from '../ledger/database.js';

export interface ReviewCandidate {
  id: string;
  content_text: string;
  created_at: string;
  days_old: number;
  tags: string[];
}

export function findDecisionsDueForReview(
  db: Database,
  projectId: string,
  days: number,
): ReviewCandidate[] {
  if (days <= 0) return [];

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.all(
    `SELECT r.id, r.content_text, r.created_at, r.tags
     FROM record r
     WHERE r.project_id = ?
       AND r.type = 'decision'
       AND r.created_at < ?
       AND r.retracted_at IS NULL
       AND r.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM record_access ra
         WHERE ra.record_id = r.id
           AND ra.accessed_at >= ?
       )
     ORDER BY r.created_at ASC
     LIMIT 10`,
    [projectId, cutoff, cutoff],
  ) as any[];

  return rows.map((r: any) => ({
    id: r.id,
    content_text: r.content_text,
    created_at: r.created_at,
    days_old: Math.floor(
      (Date.now() - new Date(r.created_at).getTime()) / (24 * 60 * 60 * 1000),
    ),
    tags: JSON.parse(r.tags),
  }));
}

/**
 * memnant — Working pattern learning.
 *
 * Story 12.4: Co-occurrence model for records accessed together.
 * Activates after 10 sessions. Boosts relevance for co-occurring records.
 */

import type { Database } from '../ledger/database.js';

/**
 * Get co-occurrence boost for a set of record IDs.
 * Returns a map of record_id → boost factor (0.0 to 0.2).
 *
 * Activates only after 10 sessions.
 */
export function getCoOccurrenceBoosts(
  db: Database,
  recordIds: string[],
): Map<string, number> {
  const boosts = new Map<string, number>();
  if (recordIds.length === 0) return boosts;

  // Check session count — only activate after 10 sessions
  const sessionRow = db.get(
    'SELECT COUNT(*) as count FROM session',
  ) as unknown as { count: number };

  if (sessionRow.count < 10) return boosts;

  // For each record, find co-occurring records and their counts
  for (const id of recordIds) {
    const rows = db.all(
      `SELECT co_occurrence_count FROM access_pattern
       WHERE record_id_a = ? OR record_id_b = ?`,
      [id, id],
    ) as unknown as Array<{ co_occurrence_count: number }>;

    if (rows.length === 0) continue;

    // Average co-occurrence count, normalized with sigmoid-like curve
    const totalCount = rows.reduce((sum, r) => sum + r.co_occurrence_count, 0);
    const avgCount = totalCount / rows.length;

    // Sigmoid normalization: max boost 0.2, reaches ~0.15 at count=5
    const boost = 0.2 * (1 - 1 / (1 + avgCount / 3));
    boosts.set(id, Math.round(boost * 1000) / 1000);
  }

  return boosts;
}

/**
 * Get records that frequently co-occur with the given record.
 * Returns record IDs sorted by co-occurrence count (descending).
 */
export function getCoOccurringRecords(
  db: Database,
  recordId: string,
  limit: number = 5,
): Array<{ record_id: string; count: number }> {
  const rows = db.all(
    `SELECT
       CASE WHEN record_id_a = ? THEN record_id_b ELSE record_id_a END as record_id,
       co_occurrence_count as count
     FROM access_pattern
     WHERE record_id_a = ? OR record_id_b = ?
     ORDER BY co_occurrence_count DESC
     LIMIT ?`,
    [recordId, recordId, recordId, limit],
  ) as unknown as Array<{ record_id: string; count: number }>;

  return rows;
}

/**
 * memnant — Access tracking for relevance decay.
 *
 * Story 10.2: Track every access to records for frequency-based scoring.
 */

import type { Database } from '../ledger/database.js';

/**
 * Record that a set of records was accessed.
 */
export function trackAccess(
  db: Database,
  recordIds: string[],
  context: string,
): void {
  if (recordIds.length === 0) return;

  const now = new Date().toISOString();

  db.run('BEGIN');
  try {
    for (const recordId of recordIds) {
      db.run(
        'INSERT INTO record_access (record_id, accessed_at, context) VALUES (?, ?, ?)',
        [recordId, now, context],
      );
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/**
 * Get the number of times a record has been accessed.
 */
export function getAccessCount(db: Database, recordId: string): number {
  const row = db.get(
    'SELECT COUNT(*) as count FROM record_access WHERE record_id = ?',
    [recordId],
  ) as unknown as { count: number };
  return row.count;
}

/**
 * Get the most recent access time for a record.
 */
export function getLastAccessTime(db: Database, recordId: string): string | null {
  const row = db.get(
    'SELECT MAX(accessed_at) as last FROM record_access WHERE record_id = ?',
    [recordId],
  ) as unknown as { last: string | null };
  return row.last;
}

/**
 * Get access counts for multiple records in a single query.
 */
export function getAccessCounts(db: Database, recordIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (recordIds.length === 0) return counts;

  const placeholders = recordIds.map(() => '?').join(',');
  const rows = db.all(
    `SELECT record_id, COUNT(*) as count FROM record_access WHERE record_id IN (${placeholders}) GROUP BY record_id`,
    recordIds,
  ) as unknown as Array<{ record_id: string; count: number }>;

  for (const row of rows) {
    counts.set(row.record_id, row.count);
  }

  return counts;
}

/**
 * Update co-occurrence patterns when records are accessed together.
 */
export function updateAccessPatterns(db: Database, recordIds: string[]): void {
  if (recordIds.length < 2) return;

  const now = new Date().toISOString();

  db.run('BEGIN');
  try {
    // Generate all pairs
    for (let i = 0; i < recordIds.length; i++) {
      for (let j = i + 1; j < recordIds.length; j++) {
        const [a, b] = recordIds[i] < recordIds[j]
          ? [recordIds[i], recordIds[j]]
          : [recordIds[j], recordIds[i]];

        db.run(
          `INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(record_id_a, record_id_b)
           DO UPDATE SET co_occurrence_count = co_occurrence_count + 1, last_seen = ?`,
          [a, b, now, now],
        );
      }
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

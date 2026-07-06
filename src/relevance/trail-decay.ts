/**
 * memnant — Trail decay.
 *
 * Prunes co-occurrence trails that haven't been reinforced.
 * Trails older than 90 days with count < 3 are removed.
 */

import type { Database } from '../ledger/database.js';

const TRAIL_MAX_AGE_DAYS = 90;
const TRAIL_MIN_COUNT = 3;

export function pruneStaleTrails(db: Database): number {
  const cutoff = new Date(Date.now() - TRAIL_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = db.run(
    'DELETE FROM access_pattern WHERE last_seen < ? AND co_occurrence_count < ?',
    [cutoff, TRAIL_MIN_COUNT],
  );

  return (result as unknown as { changes: number })?.changes ?? 0;
}

/**
 * memnant — Ledger administration: retraction and archiving.
 *
 * Retraction marks a record as withdrawn (with a reason).
 * Archiving hides a record from default queries without deleting it.
 *
 * Both operations are reversible. Records are never deleted.
 */

import type { Database } from './database.js';

/**
 * Retract a record — mark it as withdrawn with a reason.
 * Sets retracted_at to now and retracted_reason to the given reason.
 * Throws if the record does not exist.
 */
export function retractRecord(db: Database, recordId: string, reason: string): void {
  const row = db.get('SELECT id FROM record WHERE id = ?', [recordId]) as unknown as { id: string } | undefined;
  if (!row) {
    throw new Error(`Record '${recordId}' not found. Cannot retract a record that does not exist.`);
  }

  const now = new Date().toISOString();
  db.run(
    'UPDATE record SET retracted_at = ?, retracted_reason = ? WHERE id = ?',
    [now, reason, recordId],
  );
}

/**
 * Un-retract a record — clear retracted_at and retracted_reason.
 * Throws if the record does not exist.
 */
export function unretractRecord(db: Database, recordId: string): void {
  const row = db.get('SELECT id FROM record WHERE id = ?', [recordId]) as unknown as { id: string } | undefined;
  if (!row) {
    throw new Error(`Record '${recordId}' not found. Cannot unretract a record that does not exist.`);
  }

  db.run(
    'UPDATE record SET retracted_at = NULL, retracted_reason = NULL WHERE id = ?',
    [recordId],
  );
}

/**
 * Archive a record — set archived_at to now.
 * Throws if the record does not exist.
 */
export function archiveRecord(db: Database, recordId: string): void {
  const row = db.get('SELECT id FROM record WHERE id = ?', [recordId]) as unknown as { id: string } | undefined;
  if (!row) {
    throw new Error(`Record '${recordId}' not found. Cannot archive a record that does not exist.`);
  }

  const now = new Date().toISOString();
  db.run(
    'UPDATE record SET archived_at = ? WHERE id = ?',
    [now, recordId],
  );
}

/**
 * Un-archive a record — clear archived_at.
 * Throws if the record does not exist.
 */
export function unarchiveRecord(db: Database, recordId: string): void {
  const row = db.get('SELECT id FROM record WHERE id = ?', [recordId]) as unknown as { id: string } | undefined;
  if (!row) {
    throw new Error(`Record '${recordId}' not found. Cannot unarchive a record that does not exist.`);
  }

  db.run(
    'UPDATE record SET archived_at = NULL WHERE id = ?',
    [recordId],
  );
}

/**
 * Un-archive all archived records. Returns the number of records unarchived.
 */
export function unarchiveAll(db: Database): number {
  const countRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE archived_at IS NOT NULL',
  ) as unknown as { count: number };

  if (countRow.count === 0) return 0;

  db.run('UPDATE record SET archived_at = NULL WHERE archived_at IS NOT NULL');
  return countRow.count;
}

/**
 * Archive all records that are targets of an active 'supersedes' relationship.
 * A superseded record is one where another record supersedes it
 * (target_record_id in a supersedes relationship with dismissed_at IS NULL).
 * Skips records that are already archived.
 * Returns the number of records archived.
 */
export function archiveSuperseded(db: Database): number {
  const result = db.get(`
    SELECT COUNT(*) as count FROM record
    WHERE id IN (
      SELECT target_record_id FROM record_relationship
      WHERE type = 'supersedes' AND dismissed_at IS NULL
    )
    AND archived_at IS NULL
  `) as unknown as { count: number };

  if (result.count === 0) return 0;

  const now = new Date().toISOString();
  db.run(`
    UPDATE record SET archived_at = ?
    WHERE id IN (
      SELECT target_record_id FROM record_relationship
      WHERE type = 'supersedes' AND dismissed_at IS NULL
    )
    AND archived_at IS NULL
  `, [now]);

  return result.count;
}

/**
 * Archive records that have a staleness marker AND were created more than
 * `days` days ago. Skips records that are already archived.
 * Returns the number of records archived.
 */
export function archiveStaleOlderThan(db: Database, days: number): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffISO = cutoff.toISOString();

  const result = db.get(`
    SELECT COUNT(*) as count FROM record
    WHERE staleness_marker IS NOT NULL
      AND created_at < ?
      AND archived_at IS NULL
  `, [cutoffISO]) as unknown as { count: number };

  if (result.count === 0) return 0;

  const now = new Date().toISOString();
  db.run(`
    UPDATE record SET archived_at = ?
    WHERE staleness_marker IS NOT NULL
      AND created_at < ?
      AND archived_at IS NULL
  `, [now, cutoffISO]);

  return result.count;
}

/**
 * memnant — Stigmergy: reactive cross-builder awareness.
 *
 * Detects when another builder logs something relevant to files
 * the current builder is actively working on. Surfaces contradictions
 * between the current session's records and other builders' records.
 */

import type { Database } from '../ledger/database.js';

export interface TeamUpdate {
  id: string;
  builder_id: string;
  type: string;
  content_preview: string;
  target_file: string;
}

export interface ActiveContradiction {
  my_record_id: string;
  my_content: string;
  other_record_id: string;
  other_builder: string;
  other_content: string;
}

/**
 * Find records from other builders that target files the current builder
 * has accessed this session (via context_for_file calls).
 */
export function findNewTeamRecordsForActiveFiles(
  db: Database,
  sessionId: string,
  currentBuilder: string,
): TeamUpdate[] {
  const session = db.get(
    'SELECT started_at FROM session WHERE id = ?',
    [sessionId],
  ) as unknown as { started_at: string } | undefined;
  if (!session) return [];

  // Find files accessed this session via record_access context
  const accessRows = db.all(
    "SELECT DISTINCT context FROM record_access WHERE accessed_at >= ? AND context LIKE 'file_context:%'",
    [session.started_at],
  ) as unknown as Array<{ context: string }>;

  const activeFiles = accessRows.map(r => r.context.replace('file_context:', ''));
  if (activeFiles.length === 0) return [];

  const placeholders = activeFiles.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT id, builder_id, type, content_text, target_file FROM record
     WHERE target_file IN (${placeholders})
       AND builder_id IS NOT NULL AND builder_id != ?
       AND created_at >= ?
       AND retracted_at IS NULL AND archived_at IS NULL`,
    [...activeFiles, currentBuilder, session.started_at],
  ) as unknown as Array<{
    id: string;
    builder_id: string;
    type: string;
    content_text: string;
    target_file: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    builder_id: r.builder_id,
    type: r.type,
    content_preview: r.content_text.split('\n')[0].slice(0, 150),
    target_file: r.target_file,
  }));
}

/**
 * Format team updates for injection into compiled context.
 */
export function formatTeamUpdates(updates: TeamUpdate[]): string[] {
  return updates.map(u =>
    `[just landed \u00b7 ${u.builder_id}] ${u.type}: ${u.content_preview} (${u.target_file})`,
  );
}

/**
 * Find contradictions between the current session's records and
 * other builders' records via the record_relationship graph.
 */
export function findActiveContradictions(
  db: Database,
  sessionId: string,
  currentBuilder: string,
): ActiveContradiction[] {
  const rows = db.all(
    `SELECT
       my.id as my_id, my.content_text as my_content,
       other.id as other_id, other.builder_id as other_builder, other.content_text as other_content
     FROM record my
     JOIN record_relationship rr ON (
       (rr.source_record_id = my.id AND rr.type = 'contradicts' AND rr.dismissed_at IS NULL)
       OR (rr.target_record_id = my.id AND rr.type = 'contradicts' AND rr.dismissed_at IS NULL)
     )
     JOIN record other ON (
       other.id = CASE WHEN rr.source_record_id = my.id THEN rr.target_record_id ELSE rr.source_record_id END
     )
     WHERE my.source_session = ?
       AND my.builder_id = ?
       AND other.builder_id IS NOT NULL AND other.builder_id != ?
       AND other.retracted_at IS NULL`,
    [sessionId, currentBuilder, currentBuilder],
  ) as unknown as Array<{
    my_id: string;
    my_content: string;
    other_id: string;
    other_builder: string;
    other_content: string;
  }>;

  return rows.map(r => ({
    my_record_id: r.my_id,
    my_content: r.my_content.split('\n')[0].slice(0, 100),
    other_record_id: r.other_id,
    other_builder: r.other_builder,
    other_content: r.other_content.split('\n')[0].slice(0, 100),
  }));
}

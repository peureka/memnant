/**
 * memnant — Session CRUD operations.
 *
 * Story 2.1: Create, query, and close sessions.
 * Reusable across CLI and MCP.
 */

import type { Database } from './database.js';
import { v4 as uuidv4 } from 'uuid';
import type { Session } from '../types.js';

interface SessionRow {
  id: string;
  project_id: string;
  started_at: string;
  closed_at: string | null;
  epic: string | null;
  stories_completed: string;
  log_record_id: string | null;
  log_skipped: string | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    ...row,
    stories_completed: JSON.parse(row.stories_completed),
  };
}

export function createSession(db: Database, projectId: string, epic?: string): Session {
  const id = uuidv4();
  const startedAt = new Date().toISOString();

  db.run(
    `INSERT INTO session (id, project_id, started_at, epic, stories_completed)
     VALUES (?, ?, ?, ?, '[]')`,
    [id, projectId, startedAt, epic ?? null],
  );

  return {
    id,
    project_id: projectId,
    started_at: startedAt,
    closed_at: null,
    epic: epic ?? null,
    stories_completed: [],
    log_record_id: null,
    log_skipped: null,
  };
}

export function getActiveSession(db: Database, projectId: string): Session | null {
  const row = db.get(
    'SELECT * FROM session WHERE project_id = ? AND closed_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [projectId],
  ) as unknown as SessionRow | undefined;

  return row ? rowToSession(row) : null;
}

export function getLastClosedSession(db: Database): Session | null {
  const row = db.get(
    'SELECT * FROM session WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1',
  ) as unknown as SessionRow | undefined;

  return row ? rowToSession(row) : null;
}

export function closeSession(db: Database, sessionId: string, logRecordId: string): void {
  const closedAt = new Date().toISOString();
  db.run(
    'UPDATE session SET closed_at = ?, log_record_id = ? WHERE id = ?',
    [closedAt, logRecordId, sessionId],
  );
}

export function closeSessionSkipped(db: Database, sessionId: string, reason: string): void {
  const closedAt = new Date().toISOString();
  db.run(
    'UPDATE session SET closed_at = ?, log_skipped = ? WHERE id = ?',
    [closedAt, reason, sessionId],
  );
}

export function getSessionRecordCounts(
  db: Database,
  sessionId: string,
): Record<string, number> {
  const rows = db.all(
    'SELECT type, COUNT(*) as count FROM record WHERE source_session = ? GROUP BY type',
    [sessionId],
  ) as unknown as Array<{ type: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.type] = row.count;
  }
  return counts;
}

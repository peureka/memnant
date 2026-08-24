/**
 * memnant — Session CRUD operations.
 *
 * Story 2.1: Create, query, and close sessions.
 * Reusable across CLI and MCP.
 */

import type { Database } from './database.js';
import { insertRecord } from './records.js';
import { drainCosts, serializeCostTag } from '../orchestrator/costs.js';
import { serializeEmbedding } from '../vector/embedding-utils.js';
import { v4 as uuidv4 } from 'uuid';
import type { Session } from '../types.js';

/** all-MiniLM-L6-v2 output width; see src/vector/embeddings.ts. */
const EMBEDDING_DIMENSIONS = 384;

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

  persistSessionCosts(db, sessionId);
}

/**
 * Write the session's accrued model spend into the ledger.
 *
 * callModel accrues cost but holds no database handle, so this is the point
 * where it becomes queryable. One record per call: parseCostFromRecord reads a
 * single tag per record, so batching them into one record would silently report
 * only the first.
 */
function persistSessionCosts(db: Database, sessionId: string): void {
  const costs = drainCosts();
  if (costs.length === 0) return;

  const row = db.get('SELECT project_id FROM session WHERE id = ?', [sessionId]) as
    | { project_id: string }
    | undefined;
  if (!row) return;

  // A zero vector scores 0 against every query, which is below the recall
  // similarity threshold — so cost records stay out of search results without
  // needing a type filter, and without paying to embed a machine-readable tag.
  const inertEmbedding = serializeEmbedding(new Float32Array(EMBEDDING_DIMENSIONS));

  for (const cost of costs) {
    insertRecord(db, {
      projectId: row.project_id,
      type: 'orchestrator_task',
      contentText: `${cost.tier} tier call to ${cost.model}${serializeCostTag(cost)}`,
      tags: ['cost', cost.tier],
      embedding: inertEmbedding,
      sourceSession: sessionId,
    });
  }
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

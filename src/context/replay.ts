/**
 * memnant — Context replay.
 *
 * Records and retrieves context events — the exact responses
 * served to agents via MCP tools.
 */

import { randomUUID } from 'crypto';
import type { Database } from '../ledger/database.js';
import type { ContextEvent } from '../types.js';

export interface RecordEventParams {
  sessionId?: string | null;
  toolName: string;
  query?: string | null;
  response: string;
  tokenEstimate?: number | null;
}

export function recordContextEvent(db: Database, params: RecordEventParams): ContextEvent {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO context_event (id, session_id, tool_name, query, response, token_estimate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.sessionId ?? null,
      params.toolName,
      params.query ?? null,
      params.response,
      params.tokenEstimate ?? null,
      now,
    ],
  );

  return {
    id,
    session_id: params.sessionId ?? null,
    tool_name: params.toolName,
    query: params.query ?? null,
    response: params.response,
    token_estimate: params.tokenEstimate ?? null,
    created_at: now,
  };
}

export function getContextEvents(db: Database, sessionId: string | null): ContextEvent[] {
  let sql: string;
  let params: (string | null)[];

  if (sessionId === null) {
    sql = 'SELECT * FROM context_event WHERE session_id IS NULL ORDER BY created_at ASC';
    params = [];
  } else {
    sql = 'SELECT * FROM context_event WHERE session_id = ? ORDER BY created_at ASC';
    params = [sessionId];
  }

  return db.all(sql, params) as unknown as ContextEvent[];
}

export function getAllContextEvents(db: Database): ContextEvent[] {
  return db.all('SELECT * FROM context_event ORDER BY created_at ASC') as unknown as ContextEvent[];
}

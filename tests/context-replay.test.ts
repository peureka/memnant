/**
 * Tests for Context Replay — event recording and retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { recordContextEvent, getContextEvents } from '../src/context/replay.js';

describe('Context Replay', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-replay-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES ('test-proj', 'test', '/tmp/test', '2025-01-01T00:00:00.000Z')",
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('records a context event and retrieves it', () => {
    const sessionId = 'session-123';
    db.run(
      "INSERT INTO session (id, project_id, started_at) VALUES (?, 'test-proj', '2025-01-01T00:00:00.000Z')",
      [sessionId],
    );

    recordContextEvent(db, {
      sessionId,
      toolName: 'session_context',
      query: '{"epic": "Epic 15"}',
      response: '{"sections": {}}',
      tokenEstimate: 500,
    });

    const events = getContextEvents(db, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].tool_name).toBe('session_context');
    expect(events[0].session_id).toBe(sessionId);
    expect(events[0].query).toBe('{"epic": "Epic 15"}');
    expect(events[0].response).toBe('{"sections": {}}');
    expect(events[0].token_estimate).toBe(500);
  });

  it('records events without a session', () => {
    recordContextEvent(db, {
      toolName: 'recall',
      query: 'authentication',
      response: '[]',
      tokenEstimate: 50,
    });

    const events = getContextEvents(db, null);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBeNull();
  });

  it('getContextEvents returns all events for a session across tool types', () => {
    const sessionId = 'session-789';
    db.run(
      "INSERT INTO session (id, project_id, started_at) VALUES (?, 'test-proj', '2025-01-01T00:00:00.000Z')",
      [sessionId],
    );

    recordContextEvent(db, {
      sessionId,
      toolName: 'recall',
      query: 'auth decision',
      response: JSON.stringify([{ id: 'rec-1', content: 'Use JWT' }]),
      tokenEstimate: 150,
    });
    recordContextEvent(db, {
      sessionId,
      toolName: 'session_context',
      response: JSON.stringify({ sections: { last_session: 'shipped auth' } }),
      tokenEstimate: 800,
    });

    const events = getContextEvents(db, sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].tool_name).toBe('recall');
    expect(events[1].tool_name).toBe('session_context');
  });

  it('returns events in chronological order', () => {
    const sessionId = 'session-456';
    db.run(
      "INSERT INTO session (id, project_id, started_at) VALUES (?, 'test-proj', '2025-01-01T00:00:00.000Z')",
      [sessionId],
    );

    recordContextEvent(db, {
      sessionId,
      toolName: 'session_context',
      response: 'first',
      tokenEstimate: 100,
    });
    recordContextEvent(db, {
      sessionId,
      toolName: 'recall',
      query: 'auth',
      response: 'second',
      tokenEstimate: 200,
    });

    const events = getContextEvents(db, sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].response).toBe('first');
    expect(events[1].response).toBe('second');
  });
});

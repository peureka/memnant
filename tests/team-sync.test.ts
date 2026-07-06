import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exportSharedRecords } from '../src/team/sync.js';
import { createDatabase } from '../src/ledger/database.js';

describe('team auto-export', () => {
  const testDir = join(tmpdir(), 'memnant-team-sync-' + Date.now());
  const sharedDir = join(testDir, '.memnant', 'shared');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('exports shareable session records to shared/ as individual JSON files', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    const sessionId = 'sess-001';
    const projectId = 'proj-001';

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      [projectId, 'Test', testDir, new Date().toISOString()]
    );
    db.run(
      "INSERT INTO session (id, project_id, started_at, closed_at) VALUES (?, ?, ?, ?)",
      [sessionId, projectId, new Date().toISOString(), new Date().toISOString()]
    );

    // Insert a decision (shareable) and a session_log (not shareable)
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['rec-decision', projectId, 'decision', '{}', 'Use Postgres over MySQL', '["database"]', '[]', new Date().toISOString(), sessionId]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['rec-session', projectId, 'session_log', '{}', 'Worked on DB setup', '[]', '[]', new Date().toISOString(), sessionId]
    );

    const count = exportSharedRecords(db, sessionId, projectId, sharedDir, 'alice', 'TestProject');
    db.close();

    expect(count).toBe(1);
    expect(existsSync(join(sharedDir, 'rec-decision.json'))).toBe(true);
    expect(existsSync(join(sharedDir, 'rec-session.json'))).toBe(false);

    const content = JSON.parse(readFileSync(join(sharedDir, 'rec-decision.json'), 'utf-8'));
    expect(content.type).toBe('decision');
    expect(content.builder_id).toBe('alice');
    expect(content.content_text).toBe('Use Postgres over MySQL');
  });

  it('skips records that already have a file in shared/', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    const sessionId = 'sess-002';
    const projectId = 'proj-001';

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      [projectId, 'Test', testDir, new Date().toISOString()]
    );
    db.run(
      "INSERT INTO session (id, project_id, started_at, closed_at) VALUES (?, ?, ?, ?)",
      [sessionId, projectId, new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, source_session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['rec-existing', projectId, 'decision', '{}', 'Already shared', '["api"]', '[]', new Date().toISOString(), sessionId]
    );

    // Pre-create the file
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'rec-existing.json'), '{}');

    const count = exportSharedRecords(db, sessionId, projectId, sharedDir, 'alice', 'TestProject');
    db.close();

    expect(count).toBe(0);
  });
});

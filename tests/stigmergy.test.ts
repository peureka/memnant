/**
 * Tests for stigmergy — reactive cross-builder awareness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import {
  findNewTeamRecordsForActiveFiles,
  formatTeamUpdates,
  findActiveContradictions,
} from '../src/team/stigmergy.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('Epic 17: Stigmergy', () => {
  const tmpDir = join(process.cwd(), '.tmp-stigmergy-test');
  let db: Database;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    db = createDatabase(join(tmpDir, 'ledger.db'));
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES ('p1', 'test', ?, ?)",
      [tmpDir, new Date().toISOString()],
    );
    db.run(
      "INSERT INTO session (id, project_id, started_at) VALUES ('s1', 'p1', ?)",
      [new Date().toISOString()],
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Task 4: findNewTeamRecordsForActiveFiles ---

  it('detects new team records matching files accessed this session', () => {
    const now = new Date().toISOString();

    // Create a dummy record so FK is satisfied for record_access
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records)
       VALUES ('r-dummy', 'p1', 'decision', '{}', 'dummy', ?, '[]', '[]')`,
      [now],
    );

    // Simulate file_context access for auth.ts
    db.run(
      "INSERT INTO record_access (record_id, accessed_at, context) VALUES ('r-dummy', ?, 'file_context:auth.ts')",
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, target_file, builder_id, tags, related_records)
       VALUES ('r-alice', 'p1', 'framework_fix', '{}', 'Fix auth token refresh race condition', ?, 'auth.ts', 'alice', '[]', '[]')`,
      [now],
    );

    const results = findNewTeamRecordsForActiveFiles(db, 's1', 'bob');
    expect(results.length).toBe(1);
    expect(results[0].builder_id).toBe('alice');
    expect(results[0].target_file).toBe('auth.ts');
    expect(results[0].content_preview).toContain('Fix auth token refresh');
  });

  it('ignores records from the current builder', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records)
       VALUES ('r-dummy', 'p1', 'decision', '{}', 'dummy', ?, '[]', '[]')`,
      [now],
    );

    db.run(
      "INSERT INTO record_access (record_id, accessed_at, context) VALUES ('r-dummy', ?, 'file_context:auth.ts')",
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, target_file, builder_id, tags, related_records)
       VALUES ('r-bob', 'p1', 'decision', '{}', 'My own decision', ?, 'auth.ts', 'bob', '[]', '[]')`,
      [now],
    );

    const results = findNewTeamRecordsForActiveFiles(db, 's1', 'bob');
    expect(results.length).toBe(0);
  });

  it('returns empty array when no files accessed', () => {
    const results = findNewTeamRecordsForActiveFiles(db, 's1', 'bob');
    expect(results).toEqual([]);
  });

  it('returns empty array for unknown session', () => {
    const results = findNewTeamRecordsForActiveFiles(db, 'nonexistent', 'bob');
    expect(results).toEqual([]);
  });

  it('ignores retracted records', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records)
       VALUES ('r-dummy', 'p1', 'decision', '{}', 'dummy', ?, '[]', '[]')`,
      [now],
    );

    db.run(
      "INSERT INTO record_access (record_id, accessed_at, context) VALUES ('r-dummy', ?, 'file_context:auth.ts')",
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, target_file, builder_id, tags, related_records, retracted_at)
       VALUES ('r-alice', 'p1', 'decision', '{}', 'Retracted decision', ?, 'auth.ts', 'alice', '[]', '[]', ?)`,
      [now, now],
    );

    const results = findNewTeamRecordsForActiveFiles(db, 's1', 'bob');
    expect(results.length).toBe(0);
  });

  // --- Task 5: formatTeamUpdates ---

  it('formats team updates for context injection', () => {
    const updates = [
      {
        id: 'abc12345',
        builder_id: 'alice',
        type: 'framework_fix',
        content_preview: 'Fix auth token refresh race condition',
        target_file: 'auth.ts',
      },
    ];

    const formatted = formatTeamUpdates(updates);
    expect(formatted.length).toBe(1);
    expect(formatted[0]).toContain('alice');
    expect(formatted[0]).toContain('auth.ts');
    expect(formatted[0]).toContain('framework_fix');
    expect(formatted[0]).toContain('just landed');
  });

  it('formats multiple updates', () => {
    const updates = [
      { id: 'a', builder_id: 'alice', type: 'decision', content_preview: 'Use JWT', target_file: 'auth.ts' },
      { id: 'b', builder_id: 'carol', type: 'framework_fix', content_preview: 'Fix DB pool', target_file: 'db.ts' },
    ];

    const formatted = formatTeamUpdates(updates);
    expect(formatted.length).toBe(2);
    expect(formatted[0]).toContain('alice');
    expect(formatted[1]).toContain('carol');
  });

  // --- Task 6: findActiveContradictions ---

  it('detects cross-builder contradictions for active session records', () => {
    const now = new Date().toISOString();

    // Bob's record in current session
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, source_session, builder_id, tags, related_records)
       VALUES ('r-bob', 'p1', 'decision', '{}', 'Use PostgreSQL for main DB', ?, 's1', 'bob', '[]', '[]')`,
      [now],
    );

    // Alice's contradicting record
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, builder_id, tags, related_records)
       VALUES ('r-alice', 'p1', 'decision', '{}', 'Use MySQL for main DB', ?, 'alice', '[]', '[]')`,
      [now],
    );

    // Contradiction relationship
    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-1', 'r-alice', 'r-bob', 'contradicts', 0.9, ?)`,
      [now],
    );

    const contradictions = findActiveContradictions(db, 's1', 'bob');
    expect(contradictions.length).toBe(1);
    expect(contradictions[0].other_builder).toBe('alice');
    expect(contradictions[0].my_content).toContain('PostgreSQL');
    expect(contradictions[0].other_content).toContain('MySQL');
  });

  it('ignores dismissed contradictions', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, source_session, builder_id, tags, related_records)
       VALUES ('r-bob', 'p1', 'decision', '{}', 'Use PostgreSQL', ?, 's1', 'bob', '[]', '[]')`,
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, builder_id, tags, related_records)
       VALUES ('r-alice', 'p1', 'decision', '{}', 'Use MySQL', ?, 'alice', '[]', '[]')`,
      [now],
    );

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at, dismissed_at)
       VALUES ('rel-1', 'r-alice', 'r-bob', 'contradicts', 0.9, ?, ?)`,
      [now, now],
    );

    const contradictions = findActiveContradictions(db, 's1', 'bob');
    expect(contradictions.length).toBe(0);
  });

  it('ignores contradictions with retracted records', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, source_session, builder_id, tags, related_records)
       VALUES ('r-bob', 'p1', 'decision', '{}', 'Use PostgreSQL', ?, 's1', 'bob', '[]', '[]')`,
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, builder_id, tags, related_records, retracted_at)
       VALUES ('r-alice', 'p1', 'decision', '{}', 'Use MySQL', ?, 'alice', '[]', '[]', ?)`,
      [now, now],
    );

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-1', 'r-alice', 'r-bob', 'contradicts', 0.9, ?)`,
      [now],
    );

    const contradictions = findActiveContradictions(db, 's1', 'bob');
    expect(contradictions.length).toBe(0);
  });

  it('detects contradictions regardless of relationship direction', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, source_session, builder_id, tags, related_records)
       VALUES ('r-bob', 'p1', 'decision', '{}', 'Use PostgreSQL', ?, 's1', 'bob', '[]', '[]')`,
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, builder_id, tags, related_records)
       VALUES ('r-alice', 'p1', 'decision', '{}', 'Use MySQL', ?, 'alice', '[]', '[]')`,
      [now],
    );

    // Relationship in reverse direction (bob -> alice)
    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-1', 'r-bob', 'r-alice', 'contradicts', 0.9, ?)`,
      [now],
    );

    const contradictions = findActiveContradictions(db, 's1', 'bob');
    expect(contradictions.length).toBe(1);
    expect(contradictions[0].other_builder).toBe('alice');
  });

  it('ignores same-builder contradictions', () => {
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, source_session, builder_id, tags, related_records)
       VALUES ('r-bob1', 'p1', 'decision', '{}', 'Use PostgreSQL', ?, 's1', 'bob', '[]', '[]')`,
      [now],
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, builder_id, tags, related_records)
       VALUES ('r-bob2', 'p1', 'decision', '{}', 'Use MySQL', ?, 'bob', '[]', '[]')`,
      [now],
    );

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-1', 'r-bob1', 'r-bob2', 'contradicts', 0.9, ?)`,
      [now],
    );

    const contradictions = findActiveContradictions(db, 's1', 'bob');
    expect(contradictions.length).toBe(0);
  });
});

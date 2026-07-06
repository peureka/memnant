/**
 * Integration test for ledger administration.
 *
 * Task 9: Full lifecycle covering create, retract, archive, stats, unretract, unarchive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, openDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { retractRecord, unretractRecord, archiveRecord, unarchiveRecord } from '../src/ledger/admin.js';
import { getLedgerStats } from '../src/ledger/stats.js';
import { searchRecords } from '../src/vector/search.js';
import pkg from 'node-sqlite3-wasm';
const { Database: SqliteDb } = pkg;

const PROJECT_ID = 'test-project-id';
const DUMMY_EMBEDDING = new Uint8Array(1536);

describe('Ledger Administration Integration', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-integration-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  function insertTestRecord(content: string, type: string = 'decision') {
    return insertRecord(db, {
      projectId: PROJECT_ID,
      type: type as 'decision',
      contentText: content,
      embedding: DUMMY_EMBEDDING,
    });
  }

  it('full lifecycle: create, retract, archive, stats, unretract, unarchive', () => {
    // 1. Insert 5 records
    const r1 = insertTestRecord('Decision: use React');
    const r2 = insertTestRecord('Decision: use Postgres');
    const r3 = insertTestRecord('Fix: Next.js routing workaround', 'framework_fix');
    const r4 = insertTestRecord('Decision: use Tailwind');
    const r5 = insertTestRecord('Decision: use Vercel');

    let stats = getLedgerStats(db);
    expect(stats.records.total).toBe(5);
    expect(stats.records.active).toBe(5);
    expect(stats.records.retracted).toBe(0);
    expect(stats.records.archived).toBe(0);

    // 2. Retract one
    retractRecord(db, r1.id, 'Switched to Vue');
    stats = getLedgerStats(db);
    expect(stats.records.active).toBe(4);
    expect(stats.records.retracted).toBe(1);

    // 3. Archive one
    archiveRecord(db, r2.id);
    stats = getLedgerStats(db);
    expect(stats.records.active).toBe(3);
    expect(stats.records.archived).toBe(1);

    // 4. Verify excluded from search (zero embeddings won't match threshold,
    //    but the SQL filter is the important part — verified via direct query)
    const activeRows = db.all(
      "SELECT id FROM record WHERE retracted_at IS NULL AND archived_at IS NULL",
    ) as unknown as Array<{ id: string }>;
    const activeIds = activeRows.map((r) => r.id);
    expect(activeIds).not.toContain(r1.id);
    expect(activeIds).not.toContain(r2.id);
    expect(activeIds).toContain(r3.id);
    expect(activeIds).toContain(r4.id);
    expect(activeIds).toContain(r5.id);

    // 5. Unretract — verify included again
    unretractRecord(db, r1.id);
    stats = getLedgerStats(db);
    expect(stats.records.active).toBe(4);
    expect(stats.records.retracted).toBe(0);

    // 6. Unarchive — verify included again
    unarchiveRecord(db, r2.id);
    stats = getLedgerStats(db);
    expect(stats.records.active).toBe(5);
    expect(stats.records.archived).toBe(0);

    // 7. Final stats check
    expect(stats.records.total).toBe(5);
    expect(stats.records.byType['decision']).toBe(4);
    expect(stats.records.byType['framework_fix']).toBe(1);
  });

  it('migration from v2 database preserves existing data', () => {
    // Close the current db (already v3)
    db.close();

    // Create a fresh v2 database manually
    const v2Path = join(testDir, 'v2.db');

    const rawDb = new SqliteDb(v2Path);

    // Create v2 schema (without retracted/archived columns)
    rawDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE record (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id),
        type TEXT NOT NULL CHECK(type IN ('session_log', 'decision', 'framework_fix', 'spec_snapshot', 'codebase_snapshot', 'orchestrator_task', 'synthesis_cache', 'governance_override')),
        content TEXT NOT NULL,
        content_text TEXT NOT NULL,
        embedding BLOB,
        tags TEXT NOT NULL DEFAULT '[]',
        related_records TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        source_session TEXT REFERENCES session(id),
        staleness_marker TEXT
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        log_record_id TEXT,
        log_skipped INTEGER DEFAULT 0,
        skip_reason TEXT,
        stories_completed TEXT DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES project(id)
      );
      CREATE TABLE record_relationship (
        id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL,
        target_record_id TEXT NOT NULL,
        type TEXT NOT NULL,
        similarity REAL NOT NULL,
        created_at TEXT NOT NULL,
        dismissed_at TEXT,
        UNIQUE(source_record_id, target_record_id, type)
      );
      CREATE TABLE record_access (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        access_type TEXT NOT NULL
      );
      CREATE TABLE access_co_occurrence (
        record_id_a TEXT NOT NULL,
        record_id_b TEXT NOT NULL,
        co_occurrence_count INTEGER DEFAULT 1,
        last_co_occurred_at TEXT NOT NULL,
        PRIMARY KEY (record_id_a, record_id_b)
      );
      CREATE TABLE governance_override (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_source TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      INSERT INTO schema_version (version) VALUES (2);
    `);

    // Insert a record
    const now = new Date().toISOString();
    rawDb.exec(`
      INSERT INTO project (id, name, root_path, created_at)
      VALUES ('proj-1', 'test-v2', '${testDir}', '${now}');
      INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
      VALUES ('rec-v2-1', 'proj-1', 'decision', '{}', 'Old v2 decision', '[]', '[]', '${now}');
    `);
    rawDb.close();

    // Open with openDatabase — triggers migration to v3
    const migratedDb = openDatabase(v2Path);

    // Verify record still accessible
    const row = migratedDb.get('SELECT id, content_text FROM record WHERE id = ?', ['rec-v2-1']) as unknown as { id: string; content_text: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.content_text).toBe('Old v2 decision');

    // Verify new columns exist and are null
    const fullRow = migratedDb.get(
      'SELECT retracted_at, retracted_reason, archived_at FROM record WHERE id = ?',
      ['rec-v2-1'],
    ) as unknown as { retracted_at: string | null; retracted_reason: string | null; archived_at: string | null };
    expect(fullRow.retracted_at).toBeNull();
    expect(fullRow.retracted_reason).toBeNull();
    expect(fullRow.archived_at).toBeNull();

    // Verify schema_version is 9 (migrated through v3, v4, v5, v6, v7, v8, and v9)
    const versionRow = migratedDb.get('SELECT MAX(version) as version FROM schema_version') as unknown as { version: number };
    expect(versionRow.version).toBe(12);

    // Verify v4 columns exist (AST-anchored staleness)
    const v4Row = migratedDb.get(
      'SELECT target_file, target_symbol, ast_hash FROM record WHERE id = ?',
      ['rec-v2-1'],
    ) as unknown as { target_file: string | null; target_symbol: string | null; ast_hash: string | null };
    expect(v4Row.target_file).toBeNull();
    expect(v4Row.target_symbol).toBeNull();
    expect(v4Row.ast_hash).toBeNull();

    // Verify backup exists
    expect(existsSync(v2Path + '.backup-v2')).toBe(true);

    migratedDb.close();

    // Re-open the original db for afterEach cleanup
    db = createDatabase(join(testDir, 'ledger.db'));
  });
});

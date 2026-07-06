/**
 * Tests for Migration Registry.
 *
 * Verifies:
 * 1. Auto-backup is created before migrating
 * 2. Migrations run in order (schema_version updates correctly)
 * 3. Migrations don't re-run on an already-current database
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, openDatabase, type Database } from '../src/ledger/database.js';

describe('Migration Registry', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-migrations-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates auto-backup before migrating a v2 database', () => {
    const dbPath = join(testDir, 'ledger.db');

    // Create a v2 database by hand (simulating the old schema version)
    const db = createDatabase(dbPath);
    // Downgrade to v2: remove the new columns by recreating record table without them,
    // and set schema_version to 2
    db.run('DROP TABLE IF EXISTS record');
    db.run(`
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
      )
    `);
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', [2]);
    db.close();

    // Now open it — should trigger migration v2→v3 and create a backup
    const db2 = openDatabase(dbPath);
    db2.close();

    const backupPath = `${dbPath}.backup-v2`;
    expect(existsSync(backupPath)).toBe(true);
  });

  it('runs migrations in order and updates schema_version to 9', () => {
    const dbPath = join(testDir, 'ledger.db');

    // Create a v2 database
    const db = createDatabase(dbPath);
    db.run('DROP TABLE IF EXISTS record');
    db.run(`
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
      )
    `);
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', [2]);
    db.close();

    // Open — triggers migration v2→v3→v4→v5→v6→v7→v8→v9
    const db2 = openDatabase(dbPath);

    // Check schema_version is now 8
    const row = db2.get('SELECT MAX(version) as version FROM schema_version') as unknown as { version: number };
    expect(row.version).toBe(12);

    // Check the v3 columns exist
    const tableInfo = db2.all('PRAGMA table_info(record)') as unknown as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);
    expect(columnNames).toContain('retracted_at');
    expect(columnNames).toContain('retracted_reason');
    expect(columnNames).toContain('archived_at');

    // Check the v4 columns exist (AST-anchored staleness)
    expect(columnNames).toContain('target_file');
    expect(columnNames).toContain('target_symbol');
    expect(columnNames).toContain('ast_hash');

    // Check the v5 column exists (embedding model versioning)
    expect(columnNames).toContain('embedding_model');

    // Check the v6 context_event table exists
    const eventTableInfo = db2.all('PRAGMA table_info(context_event)') as unknown as Array<{ name: string }>;
    const eventColumnNames = eventTableInfo.map((col) => col.name);
    expect(eventColumnNames).toContain('id');
    expect(eventColumnNames).toContain('session_id');
    expect(eventColumnNames).toContain('tool_name');

    db2.close();
  });

  it('runs v5 migration adding embedding_model column', () => {
    const dbPath = join(testDir, 'ledger.db');

    // Create a v4 database (has all columns through v4, but not v5)
    const db = createDatabase(dbPath);
    db.run('DROP TABLE IF EXISTS record');
    db.run(`
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
        staleness_marker TEXT,
        retracted_at TEXT,
        retracted_reason TEXT,
        archived_at TEXT,
        target_file TEXT,
        target_symbol TEXT,
        ast_hash TEXT
      )
    `);
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', [4]);
    db.close();

    // Open — should trigger migration v4→v5→v6→v7→v8
    const db2 = openDatabase(dbPath);

    const row = db2.get('SELECT MAX(version) as version FROM schema_version') as unknown as { version: number };
    expect(row.version).toBe(12);

    const tableInfo = db2.all('PRAGMA table_info(record)') as unknown as Array<{ name: string; dflt_value: string | null }>;
    const embeddingModelCol = tableInfo.find((col) => col.name === 'embedding_model');
    expect(embeddingModelCol).toBeDefined();
    expect(embeddingModelCol!.dflt_value).toBe("'Xenova/all-MiniLM-L6-v2'");

    db2.close();
  });

  it('runs v6 migration adding context_event table', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    // Recreate record table at v5 level (without v8 colony columns)
    db.run('DROP TABLE IF EXISTS record');
    db.run(`
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
        staleness_marker TEXT,
        retracted_at TEXT,
        retracted_reason TEXT,
        archived_at TEXT,
        target_file TEXT,
        target_symbol TEXT,
        ast_hash TEXT,
        embedding_model TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'
      )
    `);
    db.run('DROP TABLE IF EXISTS context_event');
    db.run('DELETE FROM schema_version');
    db.run('INSERT INTO schema_version (version) VALUES (?)', [5]);
    db.close();

    const db2 = openDatabase(dbPath);
    const row = db2.get('SELECT MAX(version) as version FROM schema_version') as unknown as { version: number };
    expect(row.version).toBe(12);

    const tableInfo = db2.all('PRAGMA table_info(context_event)') as unknown as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);
    expect(columnNames).toContain('id');
    expect(columnNames).toContain('session_id');
    expect(columnNames).toContain('tool_name');
    expect(columnNames).toContain('query');
    expect(columnNames).toContain('response');
    expect(columnNames).toContain('token_estimate');
    expect(columnNames).toContain('created_at');

    db2.close();
  });

  it('does not re-run migrations or create backup on already-current database', () => {
    const dbPath = join(testDir, 'ledger.db');

    // Create a fresh v3 database (current version)
    const db = createDatabase(dbPath);
    db.close();

    // Open it again — should not trigger any migration
    const db2 = openDatabase(dbPath);
    db2.close();

    // No backup file should exist because no migration ran
    const backupV3Path = `${dbPath}.backup-v3`;
    expect(existsSync(backupV3Path)).toBe(false);
  });
});

describe('migration v10: assumptions and builder_id', () => {
  it('adds assumptions and builder_id columns', () => {
    const testDir = join(tmpdir(), 'memnant-migration-v10-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'ledger.db');

    const db = createDatabase(dbPath);

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, assumptions, builder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['a1', 'test', 'decision', '{}', 'Test', '[]', '[]', new Date().toISOString(), '["solo developer"]', 'Alice <alice@test.com>']
    );

    const row = db.get("SELECT assumptions, builder_id FROM record WHERE id = 'a1'") as any;
    expect(row.assumptions).toBe('["solo developer"]');
    expect(row.builder_id).toBe('Alice <alice@test.com>');

    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe('migration v9: pattern fields', () => {
  it('adds pattern_strength, pattern_last_seen, supporting_records columns', () => {
    const testDir = join(tmpdir(), 'memnant-migration-v9-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'ledger.db');

    const db = createDatabase(dbPath);

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, pattern_strength, pattern_last_seen, supporting_records)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['p1', 'test', 'pattern', '{}', 'Test pattern', '[]', '[]', new Date().toISOString(), 5, new Date().toISOString(), '[{"project_id":"a","record_id":"b"}]']
    );

    const row = db.get("SELECT pattern_strength, pattern_last_seen, supporting_records FROM record WHERE id = 'p1'") as any;
    expect(row.pattern_strength).toBe(5);
    expect(row.supporting_records).toContain('project_id');

    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe('migration v11: version_of relationship type', () => {
  it('allows version_of relationship type', () => {
    const testDir = join(tmpdir(), 'memnant-migration-v11-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    const dbPath = join(testDir, 'ledger.db');

    const db = createDatabase(dbPath);

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r1', 'test', 'decision', '{}', 'V1 decision', '[]', '[]', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r2', 'test', 'decision', '{}', 'V2 decision', '[]', '[]', new Date().toISOString()]
    );

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['rel1', 'r2', 'r1', 'version_of', 1.0, new Date().toISOString()]
    );

    const rel = db.get("SELECT * FROM record_relationship WHERE id = 'rel1'") as any;
    expect(rel.type).toBe('version_of');
    expect(rel.source_record_id).toBe('r2');
    expect(rel.target_record_id).toBe('r1');

    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });
});

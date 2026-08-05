/**
 * Tests for reversible migrations and the v13 staleness_marker drop
 * (backlog: "a future clean drop needs a down-migration mechanism first").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, openDatabase, migrateDown, CURRENT_SCHEMA_VERSION, type Database } from '../src/ledger/database.js';
import pkg from 'node-sqlite3-wasm';

const { Database: SqliteDb } = pkg;

/** Column names of a table via pragma. */
function columns(db: Database, table: string): string[] {
  const rows = db.all(`PRAGMA table_info(${table})`) as unknown as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function schemaVersion(db: Database): number {
  const row = db.get('SELECT MAX(version) AS v FROM schema_version') as unknown as { v: number };
  return row.v;
}

/** Build a v2-era ledger with one record, the fixture migrations start from. */
function createV2Ledger(path: string): void {
  const raw = new SqliteDb(path);
  raw.exec(`
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
    INSERT INTO project (id, name, root_path, created_at)
      VALUES ('p1', 'test', '/tmp/test', '2026-01-01T00:00:00Z');
    INSERT INTO record (id, project_id, type, content, content_text, created_at)
      VALUES ('r1', 'p1', 'decision', '{"text":"Chose X over Y"}', 'Chose X over Y', '2026-01-01T00:00:00Z');
  `);
  raw.close();
}

describe('staleness_marker drop + down-migration', () => {
  let dir: string;
  let db: Database | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnant-migration-down-'));
  });

  afterEach(async () => {
    db?.close();
    db = null;
    await rm(dir, { recursive: true, force: true });
  });

  it('migrating an old ledger drops staleness_marker and preserves records', () => {
    const path = join(dir, 'ledger.db');
    createV2Ledger(path);

    db = openDatabase(path);

    expect(columns(db, 'record')).not.toContain('staleness_marker');
    const row = db.get('SELECT content_text FROM record WHERE id = ?', ['r1']) as unknown as {
      content_text: string;
    };
    expect(row.content_text).toBe('Chose X over Y');
    // Auto-backup was taken before the first migration ran.
    expect(existsSync(`${path}.backup-v2`)).toBe(true);
  });

  it('migrateDown restores the previous schema version with data intact', () => {
    const path = join(dir, 'ledger.db');
    createV2Ledger(path);
    db = openDatabase(path);
    expect(columns(db, 'record')).not.toContain('staleness_marker');

    migrateDown(db, 12);

    expect(columns(db, 'record')).toContain('staleness_marker');
    expect(schemaVersion(db)).toBe(12);
    const row = db.get('SELECT content_text FROM record WHERE id = ?', ['r1']) as unknown as {
      content_text: string;
    };
    expect(row.content_text).toBe('Chose X over Y');
  });

  it('migrateDown refuses to cross a migration with no down', () => {
    const path = join(dir, 'ledger.db');
    createV2Ledger(path);
    db = openDatabase(path);

    // v12 and below predate reversibility; crossing them must throw, not
    // silently corrupt the schema.
    expect(() => migrateDown(db!, 11)).toThrow(/no down/i);
    expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('a fresh database has no staleness_marker and sits at the latest version', () => {
    db = createDatabase(join(dir, 'fresh.db'));

    expect(columns(db, 'record')).not.toContain('staleness_marker');
    expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

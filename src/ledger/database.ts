/**
 * memnant — Database initialisation and access.
 *
 * Creates and opens the SQLite ledger database.
 * Schema matches the data model in docs/SPEC.md.
 *
 * Epic 9: record_relationship table for connection graph.
 * Epic 10: record_access table for relevance decay.
 * Epic 12: access_pattern table for co-occurrence model.
 */

import pkg from 'node-sqlite3-wasm';
import { mkdirSync, copyFileSync } from 'fs';
import { dirname } from 'path';
import { MIGRATIONS } from './migrations.js';

export const Database = pkg.Database;
export type Database = InstanceType<typeof Database>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS record (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  type TEXT NOT NULL CHECK(type IN ('session_log', 'decision', 'framework_fix', 'spec_snapshot', 'codebase_snapshot', 'orchestrator_task', 'synthesis_cache', 'governance_override', 'pattern')),
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
  embedding_model TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2',
  source_project_id TEXT,
  source_record_id TEXT DEFAULT NULL,
  pattern_strength INTEGER DEFAULT NULL,
  pattern_last_seen TEXT DEFAULT NULL,
  supporting_records TEXT DEFAULT NULL,
  assumptions TEXT DEFAULT NULL,
  builder_id TEXT DEFAULT NULL,
  confirmation_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  started_at TEXT NOT NULL,
  closed_at TEXT,
  epic TEXT,
  stories_completed TEXT NOT NULL DEFAULT '[]',
  log_record_id TEXT REFERENCES record(id),
  log_skipped TEXT
);

CREATE TABLE IF NOT EXISTS record_relationship (
  id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL REFERENCES record(id),
  target_record_id TEXT NOT NULL REFERENCES record(id),
  type TEXT NOT NULL CHECK(type IN ('related', 'supersedes', 'contradicts', 'version_of')),
  similarity REAL NOT NULL,
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  UNIQUE(source_record_id, target_record_id, type)
);

CREATE TABLE IF NOT EXISTS record_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL REFERENCES record(id),
  accessed_at TEXT NOT NULL,
  context TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS access_pattern (
  record_id_a TEXT NOT NULL,
  record_id_b TEXT NOT NULL,
  co_occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (record_id_a, record_id_b)
);

CREATE TABLE IF NOT EXISTS context_event (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES session(id),
  tool_name TEXT NOT NULL,
  query TEXT,
  response TEXT NOT NULL,
  token_estimate INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

const CURRENT_SCHEMA_VERSION = 12;

/**
 * Run schema migrations for existing databases.
 */
function migrateSchema(db: Database, dbPath: string): void {
  // Check if schema_version table exists
  const hasVersionTable = db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
  ) as unknown as { name: string } | undefined;

  let currentVersion = 0;
  if (hasVersionTable) {
    const row = db.get('SELECT MAX(version) as version FROM schema_version') as unknown as { version: number | null } | undefined;
    currentVersion = row?.version ?? 0;
  }

  if (currentVersion >= CURRENT_SCHEMA_VERSION) return;

  // Migration 1→2: Add new tables and update record type constraint
  if (currentVersion < 2) {
    // Add new tables (IF NOT EXISTS is safe for idempotency)
    db.run(`
      CREATE TABLE IF NOT EXISTS record_relationship (
        id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL REFERENCES record(id),
        target_record_id TEXT NOT NULL REFERENCES record(id),
        type TEXT NOT NULL CHECK(type IN ('related', 'supersedes', 'contradicts', 'version_of')),
        similarity REAL NOT NULL,
        created_at TEXT NOT NULL,
        dismissed_at TEXT,
        UNIQUE(source_record_id, target_record_id, type)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS record_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL REFERENCES record(id),
        accessed_at TEXT NOT NULL,
        context TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS access_pattern (
        record_id_a TEXT NOT NULL,
        record_id_b TEXT NOT NULL,
        co_occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (record_id_a, record_id_b)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      )
    `);

    // For existing databases, we need to recreate the record table
    // to update the CHECK constraint. Check if the constraint needs updating.
    const testRow = db.get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='record'",
    ) as unknown as { sql: string } | undefined;

    if (testRow && !testRow.sql.includes('synthesis_cache')) {
      // Need to recreate the table with updated CHECK constraint
      db.run(`
        CREATE TABLE record_new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES project(id),
          type TEXT NOT NULL CHECK(type IN ('session_log', 'decision', 'framework_fix', 'spec_snapshot', 'codebase_snapshot', 'orchestrator_task', 'synthesis_cache', 'governance_override', 'pattern')),
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
      db.run('INSERT INTO record_new SELECT * FROM record');
      db.run('DROP TABLE record');
      db.run('ALTER TABLE record_new RENAME TO record');
    }

    // Set version to 2 after v1→v2 migration
    db.run(
      'INSERT OR REPLACE INTO schema_version (version) VALUES (?)',
      [2],
    );
  }

  // Re-read current version (v1→v2 migration may have just run)
  const versionRow = db.get('SELECT MAX(version) as version FROM schema_version') as unknown as { version: number | null } | undefined;
  currentVersion = versionRow?.version ?? 0;

  // Run registry migrations in order
  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pendingMigrations.length === 0) return;

  // Auto-backup before the first migration
  const backupPath = `${dbPath}.backup-v${currentVersion}`;
  copyFileSync(dbPath, backupPath);

  for (const migration of pendingMigrations) {
    try {
      db.run('BEGIN');
      migration.up(db);
      db.run('COMMIT');
    } catch (error: unknown) {
      db.run('ROLLBACK');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Migration to v${migration.version} failed: ${message}. Your database has been restored. A backup is at ${backupPath}.`,
      );
    }
    db.run(
      'INSERT OR REPLACE INTO schema_version (version) VALUES (?)',
      [migration.version],
    );
  }
}

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_record_type ON record(type);
CREATE INDEX IF NOT EXISTS idx_record_project_id ON record(project_id);
CREATE INDEX IF NOT EXISTS idx_record_access_record_id ON record_access(record_id);
CREATE INDEX IF NOT EXISTS idx_record_access_session_id ON record_access(context);
CREATE INDEX IF NOT EXISTS idx_context_event_session_id ON context_event(session_id);
`;

export function createDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // Note: exec() is SQLite's multi-statement executor, not child_process
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.exec(INDEXES);
  db.run(
    'INSERT OR REPLACE INTO schema_version (version) VALUES (?)',
    [CURRENT_SCHEMA_VERSION],
  );
  return db;
}

export function openDatabase(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  migrateSchema(db, dbPath);
  return db;
}

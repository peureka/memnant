/**
 * memnant — Migration registry.
 *
 * Each migration upgrades the database schema by one version.
 * Migrations are run in order and wrapped in transactions.
 * Auto-backup is created before the first migration runs.
 */

import type { Database } from './database.js';

export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 3,
    description: 'Add retraction and archive support',
    up: (db) => {
      db.run('ALTER TABLE record ADD COLUMN retracted_at TEXT');
      db.run('ALTER TABLE record ADD COLUMN retracted_reason TEXT');
      db.run('ALTER TABLE record ADD COLUMN archived_at TEXT');
    },
  },
  {
    version: 4,
    description: 'Add AST-anchored staleness fields',
    up: (db) => {
      db.run('ALTER TABLE record ADD COLUMN target_file TEXT');
      db.run('ALTER TABLE record ADD COLUMN target_symbol TEXT');
      db.run('ALTER TABLE record ADD COLUMN ast_hash TEXT');
    },
  },
  {
    version: 5,
    description: 'Add embedding model versioning',
    up: (db) => {
      db.run("ALTER TABLE record ADD COLUMN embedding_model TEXT DEFAULT 'Xenova/all-MiniLM-L6-v2'");
    },
  },
  {
    version: 6,
    description: 'Add context_event table for context replay',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS context_event (
          id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES session(id),
          tool_name TEXT NOT NULL,
          query TEXT,
          response TEXT NOT NULL,
          token_estimate INTEGER,
          created_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 7,
    description: 'Add performance indexes',
    up: (db) => {
      // Use individual try/catch per index — old databases may have
      // different column names (e.g. access_type instead of context)
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_record_type ON record(type)',
        'CREATE INDEX IF NOT EXISTS idx_record_project_id ON record(project_id)',
        'CREATE INDEX IF NOT EXISTS idx_record_access_record_id ON record_access(record_id)',
        'CREATE INDEX IF NOT EXISTS idx_record_access_session_id ON record_access(context)',
        'CREATE INDEX IF NOT EXISTS idx_context_event_session_id ON context_event(session_id)',
      ];
      for (const sql of indexes) {
        try { db.run(sql); } catch { /* skip if column/table doesn't exist */ }
      }
    },
  },
  {
    version: 8,
    description: 'Add colony provenance fields',
    up: (db) => {
      db.run('ALTER TABLE record ADD COLUMN source_project_id TEXT DEFAULT NULL');
      db.run('ALTER TABLE record ADD COLUMN source_record_id TEXT DEFAULT NULL');
    },
  },
  {
    version: 9,
    description: 'Add pattern fields for compound knowledge',
    up: (db) => {
      db.run('ALTER TABLE record ADD COLUMN pattern_strength INTEGER DEFAULT NULL');
      db.run('ALTER TABLE record ADD COLUMN pattern_last_seen TEXT DEFAULT NULL');
      db.run('ALTER TABLE record ADD COLUMN supporting_records TEXT DEFAULT NULL');
    },
  },
  {
    version: 10,
    description: 'Add assumptions and builder_id fields',
    up: (db) => {
      db.run('ALTER TABLE record ADD COLUMN assumptions TEXT DEFAULT NULL');
      db.run('ALTER TABLE record ADD COLUMN builder_id TEXT DEFAULT NULL');
    },
  },
  {
    version: 11,
    description: 'Add version_of relationship type',
    up: (db) => {
      db.run(`
        CREATE TABLE record_relationship_new (
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
      db.run('INSERT INTO record_relationship_new SELECT * FROM record_relationship');
      db.run('DROP TABLE record_relationship');
      db.run('ALTER TABLE record_relationship_new RENAME TO record_relationship');
    },
  },
  {
    version: 12,
    description: 'Add confirmation_count for colony recruitment',
    up: (db) => {
      db.run('ALTER TABLE record ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 0');
    },
  },
];

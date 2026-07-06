import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getVersionHistory } from '../src/graph/history.js';
import { createDatabase } from '../src/ledger/database.js';

describe('version history', () => {
  const testDir = join(tmpdir(), 'memnant-history-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns version chain in chronological order', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-02-01T00:00:00.000Z';
    const t3 = '2026-03-01T00:00:00.000Z';

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['v1', 'test', 'decision', '{}', 'Original decision', '[]', '[]', t1]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['v2', 'test', 'decision', '{}', 'Revised decision', '[]', '[]', t2]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['v3', 'test', 'decision', '{}', 'Latest revision', '[]', '[]', t3]
    );

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['rel1', 'v2', 'v1', 'version_of', 1.0, t2]
    );
    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['rel2', 'v3', 'v2', 'version_of', 1.0, t3]
    );

    const history = getVersionHistory(db, 'v1');
    expect(history).toHaveLength(3);
    expect(history[0].id).toBe('v1');
    expect(history[1].id).toBe('v2');
    expect(history[2].id).toBe('v3');

    const historyFromV2 = getVersionHistory(db, 'v2');
    expect(historyFromV2).toHaveLength(3);

    db.close();
  });

  it('returns single record when no versions exist', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['solo', 'test', 'decision', '{}', 'Standalone', '[]', '[]', new Date().toISOString()]
    );

    const history = getVersionHistory(db, 'solo');
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('solo');

    db.close();
  });

  it('returns empty array for nonexistent record', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    const history = getVersionHistory(db, 'nonexistent');
    expect(history).toEqual([]);

    db.close();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getActiveAssumptions } from '../src/context/assumptions.js';
import { createDatabase } from '../src/ledger/database.js';

describe('assumption surfacing', () => {
  const testDir = join(tmpdir(), 'memnant-assumptions-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns grouped assumptions from decisions', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, assumptions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['d1', 'test', 'decision', '{}', 'Single server deployment', '[]', '[]', new Date().toISOString(), '["<100 concurrent users","solo developer"]']
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, assumptions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['d2', 'test', 'decision', '{}', 'No auth needed for MVP', '[]', '[]', new Date().toISOString(), '["solo developer"]']
    );

    const assumptions = getActiveAssumptions(db, 'test');
    expect(assumptions.length).toBeGreaterThanOrEqual(2);

    const solo = assumptions.find(a => a.assumption === 'solo developer');
    expect(solo).toBeDefined();
    expect(solo!.decisions).toHaveLength(2);

    const users = assumptions.find(a => a.assumption === '<100 concurrent users');
    expect(users).toBeDefined();
    expect(users!.decisions).toHaveLength(1);

    // "solo developer" should come first (more decisions depend on it)
    expect(assumptions[0].assumption).toBe('solo developer');

    db.close();
  });

  it('excludes retracted records', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, assumptions, retracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['d1', 'test', 'decision', '{}', 'Retracted', '[]', '[]', new Date().toISOString(), '["some assumption"]', new Date().toISOString()]
    );

    const assumptions = getActiveAssumptions(db, 'test');
    expect(assumptions).toEqual([]);

    db.close();
  });

  it('returns empty when no assumptions exist', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    const assumptions = getActiveAssumptions(db, 'test');
    expect(assumptions).toEqual([]);

    db.close();
  });
});

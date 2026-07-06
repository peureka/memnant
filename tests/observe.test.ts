import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { observeText } from '../src/observe/observe.js';
import { createDatabase } from '../src/ledger/database.js';

describe('observe', () => {
  const testDir = join(tmpdir(), 'memnant-observe-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts and writes a decision from text', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );

    const text = "Let's go with Postgres for the analytics database. It has better JSON support.";
    const result = await observeText(db, text, 'test-project');

    expect(result.candidatesFound).toBeGreaterThanOrEqual(1);
    expect(result.recordsWritten).toBeGreaterThanOrEqual(1);

    const records = db.all("SELECT * FROM record WHERE type = 'decision'");
    expect(records.length).toBeGreaterThanOrEqual(1);

    db.close();
  }, 30000);

  it('deduplicates against existing records', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );

    const text = "Let's go with Postgres for the analytics database.";

    // First observation
    const result1 = await observeText(db, text, 'test-project');
    expect(result1.recordsWritten).toBeGreaterThanOrEqual(1);

    // Same text again — should deduplicate
    const result2 = await observeText(db, text, 'test-project');
    expect(result2.duplicatesSkipped).toBeGreaterThanOrEqual(1);
    expect(result2.recordsWritten).toBe(0);

    db.close();
  }, 30000);

  it('returns zero counts for text with no decisions', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );

    const text = "Everything looks good. Tests are passing.";
    const result = await observeText(db, text, 'test-project');

    expect(result.candidatesFound).toBe(0);
    expect(result.recordsWritten).toBe(0);

    db.close();
  }, 30000);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeAnalytics } from '../src/analytics/analytics.js';
import { createDatabase } from '../src/ledger/database.js';

describe('ledger analytics', () => {
  const testDir = join(tmpdir(), 'memnant-analytics-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('computes decision velocity over 8 weeks', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    for (let i = 0; i < 5; i++) {
      const date = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000).toISOString();
      db.run(
        `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`r${i}`, 'test', 'decision', '{}', `Decision ${i}`, '["api"]', '[]', date]
      );
    }

    const report = await computeAnalytics(db, 'test');
    expect(report.velocity.weeks).toHaveLength(8);
    expect(report.velocity.total).toBe(5);

    db.close();
  });

  it('computes tag distribution', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r1', 'test', 'decision', '{}', 'D1', '["postgres","api"]', '[]', new Date().toISOString()]
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r2', 'test', 'decision', '{}', 'D2', '["postgres"]', '[]', new Date().toISOString()]
    );

    const report = await computeAnalytics(db, 'test');
    expect(report.knowledgeAreas[0].tag).toBe('postgres');
    expect(report.knowledgeAreas[0].count).toBe(2);

    db.close();
  });

  it('identifies forgotten decisions', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, target_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['r1', 'test', 'decision', '{}', 'Old anchored decision', '[]', '[]', oldDate, 'src/api.ts']
    );

    const report = await computeAnalytics(db, 'test');
    expect(report.coverageGaps.forgottenDecisions).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('returns zero counts for empty ledger', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()]
    );

    const report = await computeAnalytics(db, 'test');
    expect(report.velocity.total).toBe(0);
    expect(report.knowledgeAreas).toEqual([]);
    expect(report.coverageGaps.forgottenDecisions).toBe(0);
    expect(report.coverageGaps.undocumentedAreas).toBe(0);

    db.close();
  });
});

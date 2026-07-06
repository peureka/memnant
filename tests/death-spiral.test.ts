/**
 * Tests for Epic 19: Death Spiral Detection.
 *
 * Task 9: Supersession loop detection
 * Task 10: Decision churn metrics
 * Task 11: Churn alerts in session context
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

describe('Epic 19: Death Spiral Detection', () => {
  const tmpDir = join(process.cwd(), '.tmp-death-spiral-test');
  let db: Database;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    db = createDatabase(join(tmpDir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES ('p1', 'test', ?, ?)",
      [tmpDir, new Date().toISOString()]);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Task 9: Supersession loop detection ---

  it('detects loop when new record resembles superseded ancestor', async () => {
    const embA = serializeEmbedding(await generateEmbedding('Use PostgreSQL for the main database'));
    const rA = insertRecord(db, { projectId: 'p1', type: 'decision', contentText: 'Use PostgreSQL for the main database', embedding: embA });

    const embB = serializeEmbedding(await generateEmbedding('Use MySQL for the main database'));
    const rB = insertRecord(db, { projectId: 'p1', type: 'decision', contentText: 'Use MySQL for the main database', embedding: embB });

    // B supersedes A
    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-1', ?, ?, 'supersedes', 0.9, ?)`,
      [rB.id, rA.id, new Date().toISOString()],
    );

    const embC = serializeEmbedding(await generateEmbedding('Use PostgreSQL for the main database'));
    const rC = insertRecord(db, { projectId: 'p1', type: 'decision', contentText: 'Use PostgreSQL for the main database', embedding: embC });

    const { detectSupersessionLoop } = await import('../src/graph/relationships.js');
    const loop = detectSupersessionLoop(db, rC);
    expect(loop).not.toBeNull();
    expect(loop!.ancestorId).toBe(rA.id);
    expect(loop!.chainLength).toBeGreaterThanOrEqual(2);
  });

  it('returns null when no loop exists', async () => {
    const emb = serializeEmbedding(await generateEmbedding('A totally new decision'));
    const r = insertRecord(db, { projectId: 'p1', type: 'decision', contentText: 'A totally new decision', embedding: emb });

    const { detectSupersessionLoop } = await import('../src/graph/relationships.js');
    const loop = detectSupersessionLoop(db, r);
    expect(loop).toBeNull();
  });

  // --- Task 10: Decision churn metrics ---

  it('computeChurnMetrics finds high-churn topics', async () => {
    const now = new Date().toISOString();
    for (const id of ['rA', 'rB', 'rC', 'rD']) {
      db.run(
        `INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records)
         VALUES (?, 'p1', 'decision', '{}', 'Database choice', ?, '[]', '[]')`,
        [id, now],
      );
    }
    db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at) VALUES ('s1', 'rB', 'rA', 'supersedes', 0.9, ?)`, [now]);
    db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at) VALUES ('s2', 'rC', 'rB', 'supersedes', 0.9, ?)`, [now]);
    db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at) VALUES ('s3', 'rD', 'rC', 'supersedes', 0.9, ?)`, [now]);

    const { computeChurnMetrics } = await import('../src/analytics/churn.js');
    const churn = computeChurnMetrics(db);
    expect(churn.length).toBeGreaterThan(0);
    expect(churn[0].supersessionCount).toBeGreaterThanOrEqual(3);
  });

  // --- Task 11: Churn alerts in session context ---

  it('formatChurnAlerts generates warning for high-churn topics', async () => {
    const { formatChurnAlerts } = await import('../src/analytics/churn.js');
    const metrics = [{
      headRecordId: 'abc123',
      contentPreview: 'Database choice',
      supersessionCount: 4,
      chainIds: ['a', 'b', 'c', 'd'],
    }];
    const alerts = formatChurnAlerts(metrics);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('4');
    expect(alerts[0]).toContain('Database choice');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { updateAccessPatterns } from '../src/relevance/access.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('PHASE 3 integration', () => {
  const tmpDir = join(process.cwd(), '.tmp-phase3-integration');
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

  it('pheromone trail boosts appear in scored results', async () => {
    const { generateEmbedding } = await import('../src/vector/embeddings.js');
    const { serializeEmbedding } = await import('../src/vector/embedding-utils.js');
    const { relevanceSearch } = await import('../src/relevance/search.js');

    const emb1 = serializeEmbedding(await generateEmbedding('database schema'));
    const r1 = insertRecord(db, { projectId: 'p1', type: 'decision', contentText: 'Use PostgreSQL schema', embedding: emb1 });
    const emb2 = serializeEmbedding(await generateEmbedding('database migrations'));
    const r2 = insertRecord(db, { projectId: 'p1', type: 'decision', contentText: 'Prisma for migrations', embedding: emb2 });

    for (let i = 0; i < 10; i++) {
      db.run('INSERT INTO session (id, project_id, started_at) VALUES (?, ?, ?)',
        [`s${i}`, 'p1', new Date().toISOString()]);
    }
    for (let i = 0; i < 5; i++) {
      updateAccessPatterns(db, [r1.id, r2.id]);
    }

    const queryEmb = await generateEmbedding('database schema design');
    const results = await relevanceSearch(db, queryEmb, {
      limit: 10,
      noDecay: false,
      explain: true,
    });

    const withTrail = results.filter(r => r.signals?.co_occurrence);
    expect(withTrail.length).toBeGreaterThan(0);
  });

  it('churn detection works end to end', async () => {
    const { computeChurnMetrics, formatChurnAlerts } = await import('../src/analytics/churn.js');

    const now = new Date().toISOString();
    for (let i = 0; i < 4; i++) {
      db.run(`INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records)
        VALUES (?, 'p1', 'decision', '{}', 'Auth approach v${i}', ?, '[]', '[]')`, [`r${i}`, now]);
    }
    for (let i = 1; i < 4; i++) {
      db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
        VALUES (?, ?, ?, 'supersedes', 0.9, ?)`, [`rel${i}`, `r${i}`, `r${i-1}`, now]);
    }

    const metrics = computeChurnMetrics(db);
    expect(metrics.length).toBe(1);

    const alerts = formatChurnAlerts(metrics);
    expect(alerts[0]).toContain('3x');
  });
});

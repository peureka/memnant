import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { getUnresolvedContradictions } from '../src/graph/relationships.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('team status queries', () => {
  const tmpDir = join(process.cwd(), '.tmp-team-status-test');
  const dbPath = join(tmpDir, 'ledger.db');
  let db: Database;

  beforeEach(async () => {
    mkdirSync(tmpDir, { recursive: true });
    db = createDatabase(dbPath);

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      ['p1', tmpDir, new Date().toISOString()],
    );

    const emb1 = serializeEmbedding(await generateEmbedding('auth decision'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision', contentText: 'Use JWT for auth',
      embedding: emb1, builderId: 'alice',
    });
    const emb2 = serializeEmbedding(await generateEmbedding('api decision'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision', contentText: 'REST over GraphQL',
      embedding: emb2, builderId: 'bob',
    });
    const emb3 = serializeEmbedding(await generateEmbedding('fix vitest'));
    insertRecord(db, {
      projectId: 'p1', type: 'framework_fix', contentText: 'Fix vitest config',
      embedding: emb3, builderId: 'alice',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns distinct builders with record counts', () => {
    const rows = db.all(
      `SELECT builder_id, COUNT(*) as count FROM record
       WHERE builder_id IS NOT NULL
         AND created_at > datetime('now', '-30 days')
       GROUP BY builder_id
       ORDER BY count DESC`
    ) as any[];

    expect(rows.length).toBe(2);
    expect(rows.find((r: any) => r.builder_id === 'alice').count).toBe(2);
    expect(rows.find((r: any) => r.builder_id === 'bob').count).toBe(1);
  });

  it('counts unresolved contradictions', () => {
    const contradictions = getUnresolvedContradictions(db);
    expect(contradictions.length).toBe(0);
  });
});

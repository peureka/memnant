import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { relevanceSearch } from '../src/relevance/search.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('recall --builder filter', () => {
  const tmpDir = join(process.cwd(), '.tmp-recall-builder-test');
  const dbPath = join(tmpDir, 'ledger.db');
  let db: Database;

  beforeEach(async () => {
    mkdirSync(tmpDir, { recursive: true });
    db = createDatabase(dbPath);

    // Insert project to satisfy foreign key
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      ['p1', tmpDir, new Date().toISOString()],
    );

    const emb1 = serializeEmbedding(await generateEmbedding('Use JWT for authentication'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use JWT for authentication',
      embedding: emb1, builderId: 'alice',
    });

    const emb2 = serializeEmbedding(await generateEmbedding('Use OAuth for authentication'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use OAuth for authentication',
      embedding: emb2, builderId: 'bob',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters results by builder_id', async () => {
    const queryEmb = await generateEmbedding('authentication');
    const results = await relevanceSearch(db, queryEmb, {
      limit: 10,
      noDecay: true,
      builder: 'alice',
    });

    expect(results.length).toBe(1);
    expect(results[0].content_text).toContain('JWT');
  });

  it('returns all builders when no filter', async () => {
    const queryEmb = await generateEmbedding('authentication');
    const results = await relevanceSearch(db, queryEmb, {
      limit: 10,
      noDecay: true,
    });

    expect(results.length).toBe(2);
  });
});

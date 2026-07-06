import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

describe('team decisions in context', () => {
  const tmpDir = join(process.cwd(), '.tmp-team-context-test');
  const dbPath = join(tmpDir, 'ledger.db');
  let db: Database;

  beforeEach(async () => {
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    db = createDatabase(dbPath);
    db.run(
      'INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'test', tmpDir, new Date().toISOString()],
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes team decisions from other builders', async () => {
    const emb1 = serializeEmbedding(await generateEmbedding('Use JWT for auth'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use JWT for auth', embedding: emb1, builderId: 'alice',
    });
    const emb2 = serializeEmbedding(await generateEmbedding('Use Redis for caching'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use Redis for caching', embedding: emb2, builderId: 'bob',
    });

    const { compileContext } = await import('../src/context/compile.js');
    const ctx = await compileContext(db, {
      docsPath: join(tmpDir, 'docs'),
      projectRoot: tmpDir,
      projectId: 'p1',
      builder: 'alice',
    });

    expect(ctx.sections.team_decisions).toBeDefined();
    expect(ctx.sections.team_decisions!.length).toBeGreaterThan(0);
    expect(ctx.sections.team_decisions!.some((d: string) => d.includes('bob'))).toBe(true);
    // Should not include alice's own records
    expect(ctx.sections.team_decisions!.some((d: string) => d.includes('alice'))).toBe(false);
  });

  it('omits team decisions when no builder configured', async () => {
    const emb = serializeEmbedding(await generateEmbedding('Some decision'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Some decision', embedding: emb, builderId: 'alice',
    });

    const { compileContext } = await import('../src/context/compile.js');
    const ctx = await compileContext(db, {
      docsPath: join(tmpDir, 'docs'),
      projectRoot: tmpDir,
      projectId: 'p1',
    });

    expect(ctx.sections.team_decisions ?? []).toEqual([]);
  });
});

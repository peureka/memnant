import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

describe('Epic 18: Recruitment', () => {
  const tmpDir = join(process.cwd(), '.tmp-recruitment-test');
  let colonyDb: Database;

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    colonyDb = createDatabase(join(tmpDir, 'colony.db'));
    colonyDb.run("INSERT INTO project (id, name, root_path, created_at) VALUES ('colony', 'colony', ?, ?)",
      [tmpDir, new Date().toISOString()]);
  });

  afterEach(() => {
    colonyDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('colony records have confirmation_count column', () => {
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records, confirmation_count)
       VALUES ('r1', 'colony', 'framework_fix', '{}', 'Fix something', ?, '[]', '[]', 3)`,
      [new Date().toISOString()],
    );
    const row = colonyDb.get('SELECT confirmation_count FROM record WHERE id = ?', ['r1']) as any;
    expect(row.confirmation_count).toBe(3);
  });

  it('incrementConfirmation increases count', async () => {
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, created_at, tags, related_records, confirmation_count)
       VALUES ('r1', 'colony', 'framework_fix', '{}', 'Fix something', ?, '[]', '[]', 1)`,
      [new Date().toISOString()],
    );
    const { incrementConfirmation } = await import('../src/colony/promote.js');
    incrementConfirmation(colonyDb, 'r1');
    const row = colonyDb.get('SELECT confirmation_count FROM record WHERE id = ?', ['r1']) as any;
    expect(row.confirmation_count).toBe(2);
  });

  it('findDuplicate returns matching colony record ID', async () => {
    const { serializeEmbedding } = await import('../src/vector/embedding-utils.js');
    const { generateEmbedding } = await import('../src/vector/embeddings.js');
    const emb = await generateEmbedding('JWT auth token refresh');
    const embBuffer = serializeEmbedding(emb);

    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, created_at, tags, related_records, confirmation_count)
       VALUES ('r-dup', 'colony', 'framework_fix', '{}', 'JWT auth token refresh', ?, ?, '[]', '[]', 1)`,
      [embBuffer, new Date().toISOString()],
    );

    const { findDuplicate } = await import('../src/colony/promote.js');
    const result = findDuplicate(colonyDb, emb);
    expect(result).toBe('r-dup');
  });

  it('findDuplicate returns null when no match', async () => {
    const { generateEmbedding } = await import('../src/vector/embeddings.js');
    const emb = await generateEmbedding('completely unrelated topic about cooking recipes');

    const { findDuplicate } = await import('../src/colony/promote.js');
    const result = findDuplicate(colonyDb, emb);
    expect(result).toBeNull();
  });

  it('findRecruitablePatterns returns high-confirmation colony records matching topic', async () => {
    const { generateEmbedding } = await import('../src/vector/embeddings.js');
    const { serializeEmbedding } = await import('../src/vector/embedding-utils.js');
    const emb = await generateEmbedding('JWT auth token refresh');
    const embBuffer = serializeEmbedding(emb);
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, created_at, tags, related_records, confirmation_count)
       VALUES ('r-colony', 'colony', 'framework_fix', '{}', 'JWT refresh token race condition fix', ?, ?, '[]', '[]', 3)`,
      [embBuffer, new Date().toISOString()],
    );

    const { findRecruitablePatterns } = await import('../src/colony/recruitment.js');
    const queryEmb = await generateEmbedding('auth token handling');
    const results = findRecruitablePatterns(colonyDb, queryEmb, 3);
    expect(results.length).toBe(1);
    expect(results[0].confirmation_count).toBe(3);
  });

  it('skips colony records below confirmation threshold', async () => {
    const { generateEmbedding } = await import('../src/vector/embeddings.js');
    const { serializeEmbedding } = await import('../src/vector/embedding-utils.js');
    const emb = await generateEmbedding('JWT auth');
    const embBuffer = serializeEmbedding(emb);
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, created_at, tags, related_records, confirmation_count)
       VALUES ('r-low', 'colony', 'framework_fix', '{}', 'JWT fix', ?, ?, '[]', '[]', 1)`,
      [embBuffer, new Date().toISOString()],
    );

    const { findRecruitablePatterns } = await import('../src/colony/recruitment.js');
    const queryEmb = await generateEmbedding('JWT auth');
    const results = findRecruitablePatterns(colonyDb, queryEmb, 3);
    expect(results.length).toBe(0);
  });
});

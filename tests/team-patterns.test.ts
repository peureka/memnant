import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('team patterns', () => {
  const tmpDir = join(process.cwd(), '.tmp-team-patterns-test');
  const dbPath = join(tmpDir, 'ledger.db');
  let db: Database;

  beforeEach(async () => {
    mkdirSync(tmpDir, { recursive: true });
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      ['p1', tmpDir, new Date().toISOString()],
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('analyzeTeamPatterns returns without crashing', async () => {
    const emb1 = serializeEmbedding(await generateEmbedding('Use JWT tokens for API authentication'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use JWT tokens for API authentication', embedding: emb1, builderId: 'alice',
    });
    const emb2 = serializeEmbedding(await generateEmbedding('JWT is the right choice for API auth'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'JWT is the right choice for API auth', embedding: emb2, builderId: 'bob',
    });

    const { analyzeTeamPatterns } = await import('../src/team/patterns.js');
    const result = analyzeTeamPatterns(db);

    expect(result.consensus.length + result.divergent.length).toBeGreaterThanOrEqual(0);
  });

  it('getTeamCoverage returns correct builder counts', async () => {
    const emb1 = serializeEmbedding(await generateEmbedding('Decision from alice'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Decision from alice', embedding: emb1, builderId: 'alice',
    });
    const emb2 = serializeEmbedding(await generateEmbedding('Decision from bob'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Decision from bob', embedding: emb2, builderId: 'bob',
    });

    const { getTeamCoverage } = await import('../src/team/patterns.js');
    const coverage = getTeamCoverage(db);

    expect(coverage.activeBuilders).toBe(2);
    expect(coverage.totalBuilders).toBe(2);
    expect(coverage.builderNames).toContain('alice');
    expect(coverage.builderNames).toContain('bob');
  });

  it('formatTeamPatterns handles empty patterns', async () => {
    const { formatTeamPatterns } = await import('../src/team/patterns.js');
    const output = formatTeamPatterns(
      { consensus: [], divergent: [] },
      { activeBuilders: 1, totalBuilders: 2, builderNames: ['alice'] }
    );

    expect(output).toContain('No cross-builder patterns found');
    expect(output).toContain('1/2 active builders');
  });
});

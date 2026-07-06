import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { exportSharedRecords, importSharedRecords } from '../src/team/sync.js';
import { getUnresolvedContradictions } from '../src/graph/relationships.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('team layer integration', () => {
  const tmpDir = join(process.cwd(), '.tmp-team-integration-test');
  const db1Path = join(tmpDir, 'alice', 'ledger.db');
  const db2Path = join(tmpDir, 'bob', 'ledger.db');
  const sharedDir = join(tmpDir, 'shared');
  let aliceDb: Database;
  let bobDb: Database;

  beforeEach(async () => {
    mkdirSync(join(tmpDir, 'alice'), { recursive: true });
    mkdirSync(join(tmpDir, 'bob'), { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    aliceDb = createDatabase(db1Path);
    bobDb = createDatabase(db2Path);

    aliceDb.run('INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'test', tmpDir, new Date().toISOString()]);
    bobDb.run('INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'test', tmpDir, new Date().toISOString()]);

    aliceDb.run('INSERT INTO session (id, project_id, started_at) VALUES (?, ?, ?)',
      ['s1', 'p1', new Date().toISOString()]);
    bobDb.run('INSERT INTO session (id, project_id, started_at) VALUES (?, ?, ?)',
      ['s2', 'p1', new Date().toISOString()]);
  });

  afterEach(() => {
    aliceDb.close();
    bobDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('export → import → records from both builders in ledger', async () => {
    const emb1 = serializeEmbedding(await generateEmbedding('Use PostgreSQL for the main database'));
    insertRecord(aliceDb, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use PostgreSQL for the main database',
      embedding: emb1, builderId: 'alice', sourceSession: 's1',
    });

    const emb2 = serializeEmbedding(await generateEmbedding('Use MySQL for the main database'));
    insertRecord(bobDb, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use MySQL for the main database',
      embedding: emb2, builderId: 'bob', sourceSession: 's2',
    });

    // Both export to shared dir
    const aliceExported = exportSharedRecords(aliceDb, 's1', 'p1', sharedDir, 'alice', 'test');
    const bobExported = exportSharedRecords(bobDb, 's2', 'p1', sharedDir, 'bob', 'test');
    expect(aliceExported).toBe(1);
    expect(bobExported).toBe(1);

    // Alice imports Bob's records
    const imported = await importSharedRecords(aliceDb, 'p1', sharedDir);
    expect(imported).toBe(1);

    // Alice's ledger has records from both builders
    const builders = aliceDb.all(
      'SELECT DISTINCT builder_id FROM record WHERE builder_id IS NOT NULL'
    ) as any[];
    expect(builders.length).toBe(2);

    // Contradiction detection ran without error
    const contradictions = getUnresolvedContradictions(aliceDb);
    expect(contradictions).toBeDefined();
  });

  it('onboarding brief compiles from multi-builder ledger', async () => {
    const emb1 = serializeEmbedding(await generateEmbedding('Use PostgreSQL'));
    insertRecord(aliceDb, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use PostgreSQL', embedding: emb1, builderId: 'alice',
    });
    const emb2 = serializeEmbedding(await generateEmbedding('vitest fix'));
    insertRecord(aliceDb, {
      projectId: 'p1', type: 'framework_fix',
      contentText: 'vitest --pool=forks fix', embedding: emb2, builderId: 'bob',
    });

    const { compileOnboardingBrief } = await import('../src/context/onboarding.js');
    const config = {
      project: { name: 'test', id: 'p1' },
      memory: { db_path: '.memnant/ledger.db', export_path: '', snapshot_interval: 'monthly' as const, max_spec_snapshots: 5, max_codebase_snapshots: 3 },
      orchestrator: { tiers: { triage: { provider: 'anthropic', model: 'x' }, analysis: { provider: 'anthropic', model: 'x' }, build: { provider: 'anthropic', model: 'x' } }, interfaces: { telegram: { enabled: false }, cli: { enabled: true }, mcp: { enabled: true, port: 3100 } } },
      governor: { docs_path: 'docs/', lint_on_pr: true, strict_mode: false },
      security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
    } as any;

    const brief = compileOnboardingBrief(aliceDb, config, tmpDir);
    expect(brief.sections.key_decisions.length).toBeGreaterThan(0);
    expect(brief.sections.known_gotchas.length).toBeGreaterThan(0);
    expect(brief.token_estimate).toBeLessThanOrEqual(8000);
  });
});

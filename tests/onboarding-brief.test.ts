import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('onboarding brief', () => {
  const tmpDir = join(process.cwd(), '.tmp-onboarding-test');
  const dbPath = join(tmpDir, 'ledger.db');
  let db: Database;

  const config = {
    project: { name: 'test-project', id: 'p1' },
    memory: { db_path: '.memnant/ledger.db', export_path: '', snapshot_interval: 'monthly' as const, max_spec_snapshots: 5, max_codebase_snapshots: 3 },
    orchestrator: { tiers: { triage: { provider: 'anthropic', model: 'x' }, analysis: { provider: 'anthropic', model: 'x' }, build: { provider: 'anthropic', model: 'x' } }, interfaces: { telegram: { enabled: false }, cli: { enabled: true }, mcp: { enabled: true, port: 3100 } } },
    governor: { docs_path: 'docs/', lint_on_pr: true, strict_mode: false },
    security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
  } as any;

  beforeEach(async () => {
    mkdirSync(join(tmpDir, 'docs'), { recursive: true });
    db = createDatabase(dbPath);
    db.run(
      'INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      ['p1', 'test-project', tmpDir, new Date().toISOString()],
    );

    const emb1 = serializeEmbedding(await generateEmbedding('Use PostgreSQL for database'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use PostgreSQL for database. It handles our scale well.',
      embedding: emb1, builderId: 'alice',
    });

    const emb2 = serializeEmbedding(await generateEmbedding('vitest needs --pool=forks'));
    insertRecord(db, {
      projectId: 'p1', type: 'framework_fix',
      contentText: 'vitest needs --pool=forks for WASM modules. Without it, tests hang.',
      embedding: emb2, builderId: 'bob',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles onboarding brief with populated sections', async () => {
    const { compileOnboardingBrief } = await import('../src/context/onboarding.js');
    const brief = compileOnboardingBrief(db, config, tmpDir);

    expect(brief.project_name).toBe('test-project');
    expect(brief.sections.key_decisions.length).toBeGreaterThan(0);
    expect(brief.sections.known_gotchas.length).toBeGreaterThan(0);
    expect(brief.token_estimate).toBeGreaterThan(0);
    expect(brief.token_estimate).toBeLessThanOrEqual(8000);
  });

  it('formats brief as markdown with headings', async () => {
    const { compileOnboardingBrief, formatOnboardingBrief } = await import('../src/context/onboarding.js');
    const brief = compileOnboardingBrief(db, config, tmpDir);
    const md = formatOnboardingBrief(brief);

    expect(md).toContain('# Onboarding: test-project');
    expect(md).toContain('## Key Decisions');
    expect(md).toContain('## Known Gotchas');
    expect(md).toContain('Token estimate:');
  });

  it('respects token budget when --full is not set', async () => {
    // Add many decisions to potentially exceed budget
    for (let i = 0; i < 20; i++) {
      const emb = serializeEmbedding(await generateEmbedding(`Decision number ${i} about architecture choices`));
      insertRecord(db, {
        projectId: 'p1', type: 'decision',
        contentText: `Decision ${i}: We chose architecture pattern ${i} because it provides better scalability and maintainability for our use case.`,
        embedding: emb, builderId: i % 2 === 0 ? 'alice' : 'bob',
      });
    }

    const { compileOnboardingBrief } = await import('../src/context/onboarding.js');
    const brief = compileOnboardingBrief(db, config, tmpDir);

    expect(brief.token_estimate).toBeLessThanOrEqual(8000);
  });

  it('includes stale knowledge section', async () => {
    const { compileOnboardingBrief } = await import('../src/context/onboarding.js');
    const brief = compileOnboardingBrief(db, config, tmpDir);

    // The decision we inserted should appear in stale knowledge (oldest decisions)
    expect(brief.stale_knowledge.length).toBeGreaterThan(0);
  });

  it('handles empty ledger gracefully', async () => {
    // Create a fresh DB with no records
    const emptyDir = join(process.cwd(), '.tmp-onboarding-empty');
    mkdirSync(join(emptyDir, 'docs'), { recursive: true });
    const emptyDb = createDatabase(join(emptyDir, 'ledger.db'));
    emptyDb.run(
      'INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      ['p2', 'empty-project', emptyDir, new Date().toISOString()],
    );

    try {
      const { compileOnboardingBrief, formatOnboardingBrief } = await import('../src/context/onboarding.js');
      const emptyConfig = { ...config, project: { name: 'empty-project', id: 'p2' } };
      const brief = compileOnboardingBrief(emptyDb, emptyConfig, emptyDir);

      expect(brief.project_name).toBe('empty-project');
      expect(brief.sections.key_decisions).toEqual([]);
      expect(brief.sections.known_gotchas).toEqual([]);

      const md = formatOnboardingBrief(brief);
      expect(md).toContain('# Onboarding: empty-project');
    } finally {
      emptyDb.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

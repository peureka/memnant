import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('team synthesis', () => {
  const tmpDir = join(process.cwd(), '.tmp-team-synthesis-test');
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

  it('includes builder names in fallback output', async () => {
    const emb1 = serializeEmbedding(await generateEmbedding('Use JWT for auth'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use JWT for auth', embedding: emb1, builderId: 'alice',
    });
    const emb2 = serializeEmbedding(await generateEmbedding('Use OAuth for auth'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Use OAuth for auth', embedding: emb2, builderId: 'bob',
    });
    const emb3 = serializeEmbedding(await generateEmbedding('Session tokens for auth'));
    insertRecord(db, {
      projectId: 'p1', type: 'decision',
      contentText: 'Session tokens for auth', embedding: emb3, builderId: 'carol',
    });

    const { synthesise } = await import('../src/synthesis/synthesise.js');
    const config = {
      project: { name: 'test', id: 'p1' },
      memory: { db_path: '.memnant/ledger.db', export_path: '', snapshot_interval: 'monthly' as const, max_spec_snapshots: 5, max_codebase_snapshots: 3 },
      orchestrator: { tiers: { triage: { provider: 'anthropic', model: 'x' }, analysis: { provider: 'anthropic', model: 'x' }, build: { provider: 'anthropic', model: 'x' } }, interfaces: { telegram: { enabled: false }, cli: { enabled: true }, mcp: { enabled: true, port: 3100 } } },
      governor: { docs_path: 'docs/', lint_on_pr: true, strict_mode: false },
      security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
    } as any;

    const result = await synthesise(db, 'What auth approach should I use?', config, {
      projectRoot: tmpDir,
    });

    expect(result.fallback).toBe(true);
    // Builder names should appear in the answer
    expect(result.answer).toMatch(/alice|bob|carol/);
  });
});

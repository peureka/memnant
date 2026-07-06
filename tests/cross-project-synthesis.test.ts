import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { synthesise } from '../src/synthesis/synthesise.js';
import { createDatabase } from '../src/ledger/database.js';
import { openColonyDb } from '../src/colony/colony.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import type { ProjectConfig } from '../src/types.js';

const minimalConfig = {
  project: { name: 'test', id: 'test-id' },
  memory: { db_path: '.memnant/ledger.db', export_path: '.memnant/export/' },
  orchestrator: {
    tiers: {
      triage: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      analysis: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      build: { provider: 'anthropic', model: 'claude-opus-4-6' },
    },
    interfaces: { cli: { enabled: true }, mcp: { enabled: true, port: 3100 } },
  },
  governor: { docs_path: 'docs/', lint_on_pr: true, strict_mode: false },
  security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
} as unknown as ProjectConfig;

describe('cross-project synthesis', () => {
  const testDir = join(tmpdir(), 'memnant-cross-synth-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('includes colony results when includeColony is true', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-id', 'Test', testDir, new Date().toISOString()]
    );

    const emb = await generateEmbedding('React useEffect hook for fetching data on mount');
    const embBuf = serializeEmbedding(emb);
    insertRecord(db, {
      projectId: 'test-id',
      type: 'decision',
      contentText: 'React useEffect hook for fetching data on mount',
      embedding: embBuf,
    });

    const colonyPath = join(testDir, 'colony.db');
    const colonyDb = openColonyDb(colonyPath);
    const colonyEmb = await generateEmbedding('React useEffect cleanup function to prevent memory leaks');
    const colonyEmbBuf = serializeEmbedding(colonyEmb);
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, embedding, source_project_id, source_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['colony-rec', 'colony', 'framework_fix', '{}', 'React useEffect cleanup function to prevent memory leaks', '["react"]', '[]', new Date().toISOString(), colonyEmbBuf, 'other-project', 'orig-rec']
    );

    const result = await synthesise(db, 'React useEffect data fetching and cleanup', minimalConfig, {
      includeColony: true,
      colonyDb,
    });

    expect(result.citations.length).toBeGreaterThanOrEqual(2);
    expect(result.citations.some(c => c.id === 'colony-rec')).toBe(true);
    const colonyCitation = result.citations.find(c => c.id === 'colony-rec')!;
    expect(colonyCitation.source).toBe('colony');

    db.close();
    colonyDb.close();
  });

  it('works without colony when includeColony is false', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-id', 'Test', testDir, new Date().toISOString()]
    );

    const emb = await generateEmbedding('We use Postgres for the database');
    const embBuf = serializeEmbedding(emb);
    insertRecord(db, {
      projectId: 'test-id',
      type: 'decision',
      contentText: 'We use Postgres for the database',
      embedding: embBuf,
    });

    const result = await synthesise(db, 'What database do we use?', minimalConfig);
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.citations.every(c => c.source === 'local')).toBe(true);

    db.close();
  });
});

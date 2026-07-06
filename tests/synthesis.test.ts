/**
 * Tests for Epic 11: Synthesis.
 *
 * Story 11.1: Synthesis query tool.
 * Story 11.2: Pattern detection.
 * Story 11.3: Synthesis cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});
import { synthesise } from '../src/synthesis/synthesise.js';
import { getCachedSyntheses, cacheSynthesis, pruneExpiredSyntheses } from '../src/synthesis/cache.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';

function makeConfig(): ProjectConfig {
  return {
    project: { name: 'test', id: PROJECT_ID },
    memory: {
      db_path: '.memnant/ledger.db',
      export_path: '.memnant/export/',
      snapshot_interval: 'monthly',
      max_spec_snapshots: 5,
      max_codebase_snapshots: 3,
    },
    orchestrator: {
      tiers: {
        triage: { provider: 'anthropic', model: 'test' },
        analysis: { provider: 'anthropic', model: 'test' },
        build: { provider: 'anthropic', model: 'test' },
      },
      interfaces: {
        telegram: { enabled: false },
        cli: { enabled: true },
        mcp: { enabled: true, port: 3100 },
      },
    },
    governor: { docs_path: 'docs/', lint_on_pr: false, strict_mode: false },
    security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
  } as ProjectConfig;
}

describe('Epic 11: Synthesis', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-synthesis-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  async function insertTestRecord(content: string, type: string = 'decision') {
    const embedding = await generateEmbedding(content);
    const embeddingBuffer = serializeEmbedding(embedding);
    return insertRecord(db, {
      projectId: PROJECT_ID,
      type: type as 'decision',
      contentText: content,
      embedding: embeddingBuffer,
    });
  }

  describe('Story 11.1: Synthesis query', () => {
    it('returns fallback when fewer than 3 records', async () => {
      await insertTestRecord('Decision: use PostgreSQL');

      const config = makeConfig();
      const result = await synthesise(db, 'what database do we use?', config, { projectRoot: testDir });

      expect(result.fallback).toBe(true);
      expect(result.record_count).toBeLessThan(3);
    });

    it('returns "no relevant records" for empty ledger', async () => {
      const config = makeConfig();
      const result = await synthesise(db, 'what is our architecture?', config, { projectRoot: testDir });

      expect(result.fallback).toBe(true);
      expect(result.record_count).toBe(0);
      expect(result.answer).toContain('No relevant records');
    });

    it('includes citations with short IDs', async () => {
      await insertTestRecord('PostgreSQL database decision for JSON support');
      await insertTestRecord('PostgreSQL database selected for JSONB capabilities');

      const config = makeConfig();
      const result = await synthesise(db, 'PostgreSQL database decision', config, { projectRoot: testDir });

      expect(result.citations.length).toBeGreaterThan(0);
      for (const c of result.citations) {
        expect(c.short_id).toHaveLength(8);
        expect(c.type).toBeTruthy();
        expect(c.relevance).toBeGreaterThan(0);
      }
    });
  });

  describe('Story 11.3: Synthesis cache', () => {
    it('caches and retrieves syntheses', async () => {
      await cacheSynthesis(db, PROJECT_ID, 'Database choices', 'We consistently chose PostgreSQL for JSON support.');

      const cached = getCachedSyntheses(db);
      expect(cached.length).toBe(1);
      expect(cached[0].topic).toBe('Database choices');
      expect(cached[0].synthesis).toContain('PostgreSQL');
      expect(cached[0].is_expired).toBe(false);
    });

    it('marks old syntheses as expired', async () => {
      const id = await cacheSynthesis(db, PROJECT_ID, 'Old topic', 'Old synthesis');

      // Manually backdate the record
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.run('UPDATE record SET created_at = ? WHERE id = ?', [oldDate, id]);

      const cached = getCachedSyntheses(db);
      expect(cached.length).toBe(1);
      expect(cached[0].is_expired).toBe(true);
    });

    it('prunes expired syntheses', async () => {
      const id = await cacheSynthesis(db, PROJECT_ID, 'Expired', 'Old data');
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.run('UPDATE record SET created_at = ? WHERE id = ?', [oldDate, id]);

      const pruned = pruneExpiredSyntheses(db);
      expect(pruned).toBe(1);

      const cached = getCachedSyntheses(db);
      expect(cached.length).toBe(0);
    });
  });
});

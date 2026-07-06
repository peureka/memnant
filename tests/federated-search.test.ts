/**
 * Tests for federated search across multiple project ledgers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { createDatabase } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

describe('Federated Search', () => {
  let testDir: string;
  let projectADir: string;
  let projectBDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-federated-'));
    projectADir = join(testDir, 'project-a');
    projectBDir = join(testDir, 'project-b');
    await mkdir(join(projectADir, '.memnant'), { recursive: true });
    await mkdir(join(projectBDir, '.memnant'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function setupProject(dir: string, name: string, id: string) {
    const dbPath = join(dir, '.memnant', 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      [id, name, dir, new Date().toISOString()],
    );
    const config = {
      project: { name, id },
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
    };
    writeFileSync(join(dir, 'memnant.yaml'), yaml.dump(config));
    return db;
  }

  describe('federatedSearch', () => {
    it('searches across multiple project databases', async () => {
      const dbA = setupProject(projectADir, 'project-a', 'id-a');
      const dbB = setupProject(projectBDir, 'project-b', 'id-b');

      const embA = await generateEmbedding('Database decision chose PostgreSQL for JSON support');
      insertRecord(dbA, {
        projectId: 'id-a',
        type: 'decision',
        contentText: 'Database decision chose PostgreSQL for JSON support',
        embedding: serializeEmbedding(embA),
      });
      const embB = await generateEmbedding('Database decision chose MongoDB for document storage');
      insertRecord(dbB, {
        projectId: 'id-b',
        type: 'decision',
        contentText: 'Database decision chose MongoDB for document storage',
        embedding: serializeEmbedding(embB),
      });

      dbA.close();
      dbB.close();

      const { federatedSearch } = await import('../src/registry/federated-search.js');

      const projects = [
        { name: 'project-a', root_path: projectADir, db_path: '.memnant/ledger.db' },
        { name: 'project-b', root_path: projectBDir, db_path: '.memnant/ledger.db' },
      ];

      const results = await federatedSearch('Database decision chose', projects, { limit: 5 });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.source_project).toBeTruthy();
        expect(['project-a', 'project-b']).toContain(r.source_project);
      }
    });

    it('returns empty array for no matching projects', async () => {
      const { federatedSearch } = await import('../src/registry/federated-search.js');
      const results = await federatedSearch('anything', [], { limit: 5 });
      expect(results).toEqual([]);
    });

    it('skips projects with missing databases', async () => {
      const { federatedSearch } = await import('../src/registry/federated-search.js');
      const projects = [
        { name: 'missing', root_path: '/nonexistent/path', db_path: '.memnant/ledger.db' },
      ];
      const results = await federatedSearch('test', projects, { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe('resolveProjects', () => {
    it('filters by project names', async () => {
      const { resolveProjects } = await import('../src/registry/federated-search.js');
      const registry = [
        { name: 'project-a', root_path: projectADir },
        { name: 'project-b', root_path: projectBDir },
      ];

      // Setup config for project-a so resolveProjects can read db_path
      setupProject(projectADir, 'project-a', 'id-a').close();

      const resolved = resolveProjects(['project-a'], registry);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('project-a');
    });

    it('returns all when no names specified', async () => {
      const { resolveProjects } = await import('../src/registry/federated-search.js');
      setupProject(projectADir, 'project-a', 'id-a').close();
      setupProject(projectBDir, 'project-b', 'id-b').close();

      const registry = [
        { name: 'project-a', root_path: projectADir },
        { name: 'project-b', root_path: projectBDir },
      ];

      const resolved = resolveProjects(undefined, registry);
      expect(resolved).toHaveLength(2);
    });
  });

  describe('CLI and MCP registration', () => {
    it('search command is registered in CLI index', () => {
      const indexCode = readFileSync('src/cli/index.ts', 'utf-8');
      expect(indexCode).toContain('registerSearchCommand');
    });

    it('federated_recall tool is registered in MCP server', () => {
      const serverCode = readFileSync('src/mcp/server.ts', 'utf-8');
      expect(serverCode).toContain('memnant_federated_recall');
    });
  });
});

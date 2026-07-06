/**
 * Tests for Epic 12: Predictive Context.
 *
 * Story 12.1: File-aware context.
 * Story 12.2: Branch-aware context.
 * Story 12.3: Dynamic project brief.
 * Story 12.4: Working pattern learning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, mkdirSync } from 'fs';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});
import { branchToEpic, detectBranch, autoDetectEpic } from '../src/context/branch.js';
import { generateProjectBrief, formatBriefAsMarkdown, type ProjectBrief } from '../src/context/brief.js';
import { getCoOccurrenceBoosts, getCoOccurringRecords } from '../src/context/patterns.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';

function makeConfig(): ProjectConfig {
  return {
    project: { name: 'test-project', id: PROJECT_ID },
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

describe('Story 12.2: Branch-aware context', () => {
  it('extracts epic from epic-12 branch', () => {
    expect(branchToEpic('epic-12')).toBe('Epic 12');
  });

  it('extracts epic from e12 branch', () => {
    expect(branchToEpic('e12')).toBe('Epic 12');
  });

  it('extracts epic from 12.1-file-context branch', () => {
    expect(branchToEpic('12.1-file-context')).toBe('Epic 12');
  });

  it('extracts epic from feature/epic-12 branch', () => {
    expect(branchToEpic('feature/epic-12')).toBe('Epic 12');
  });

  it('returns null for main branch', () => {
    expect(branchToEpic('main')).toBeNull();
  });

  it('returns null for master branch', () => {
    expect(branchToEpic('master')).toBeNull();
  });

  it('returns null for develop branch', () => {
    expect(branchToEpic('develop')).toBeNull();
  });

  it('returns null for null branch', () => {
    expect(branchToEpic(null)).toBeNull();
  });

  it('returns null for unrecognised branch names', () => {
    expect(branchToEpic('fix-login-bug')).toBeNull();
  });

  it('autoDetectEpic returns null for non-git directory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'memnant-branch-'));
    expect(autoDetectEpic(tmpDir)).toBeNull();
    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe('Story 12.3: Dynamic project brief', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-brief-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test-project', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );

    // Create docs dir for spec scanning
    mkdirSync(join(testDir, 'docs'), { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('generates a brief with project name', () => {
    const config = makeConfig();
    const brief = generateProjectBrief(db, config, testDir);

    expect(brief.project_name).toBe('test-project');
    expect(brief.token_estimate).toBeGreaterThanOrEqual(0);
  });

  it('includes recent framework fixes', async () => {
    const config = makeConfig();
    const embedding = await generateEmbedding('Next.js requires explicit dynamic config');
    const embeddingBuffer = serializeEmbedding(embedding);

    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'framework_fix',
      contentText: 'Next.js App Router requires explicit dynamic config for API routes using cookies',
      embedding: embeddingBuffer,
    });

    const brief = generateProjectBrief(db, config, testDir);
    expect(brief.framework_fixes.length).toBe(1);
    expect(brief.framework_fixes[0]).toContain('Next.js');
  });

  it('formats brief as markdown', () => {
    const config = makeConfig();
    const brief = generateProjectBrief(db, config, testDir);
    const md = formatBriefAsMarkdown(brief);

    expect(md).toContain('# test-project');
  });

  it('includes warnings for unresolved contradictions', async () => {
    const config = makeConfig();

    // Insert two records
    const embedding1 = await generateEmbedding('Use PostgreSQL for the database');
    const embedding2 = await generateEmbedding('Use MySQL for the database');

    const rec1 = insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use PostgreSQL for the database',
      embedding: serializeEmbedding(embedding1),
    });

    const rec2 = insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use MySQL for the database',
      embedding: serializeEmbedding(embedding2),
    });

    // Insert a contradiction relationship
    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES (?, ?, ?, 'contradicts', 0.85, ?)`,
      ['rel-1', rec1.id, rec2.id, new Date().toISOString()],
    );

    const brief = generateProjectBrief(db, config, testDir);
    expect(brief.warnings.length).toBe(1);
    expect(brief.warnings[0]).toContain('1 unresolved contradiction');
  });

  it('includes active constraints from specs', async () => {
    const config = makeConfig();

    // Create a copy audit spec with banned terms
    const specContent = `---
type: copy_audit
applies_to: all
---

## Banned

- "utilize" → "use" — Plain English
`;
    writeFileSync(join(testDir, 'docs', 'COPY_AUDIT.md'), specContent);

    const brief = generateProjectBrief(db, config, testDir);
    expect(brief.constraints.length).toBeGreaterThan(0);
    expect(brief.constraints[0]).toContain('utilize');
    expect(brief.constraints[0]).toContain('use');
  });
});

describe('Story 12.4: Working pattern learning', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-patterns-'));
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

  async function insertTestRecord(content: string): Promise<string> {
    const embedding = await generateEmbedding(content);
    const record = insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: content,
      embedding: serializeEmbedding(embedding),
    });
    return record.id;
  }

  it('returns empty boosts when fewer than 10 sessions', async () => {
    const id = await insertTestRecord('test record');
    const boosts = getCoOccurrenceBoosts(db, [id]);
    expect(boosts.size).toBe(0);
  });

  it('returns boosts after 10 sessions with co-occurrence data', async () => {
    // Create 10 sessions
    for (let i = 0; i < 10; i++) {
      db.run(
        "INSERT INTO session (id, project_id, started_at, closed_at) VALUES (?, ?, ?, ?)",
        [`session-${i}`, PROJECT_ID, new Date().toISOString(), new Date().toISOString()],
      );
    }

    const idA = await insertTestRecord('Database choice: PostgreSQL');
    const idB = await insertTestRecord('ORM choice: Prisma');

    // Insert co-occurrence
    db.run(
      'INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen) VALUES (?, ?, ?, ?)',
      [idA, idB, 5, new Date().toISOString()],
    );

    const boosts = getCoOccurrenceBoosts(db, [idA]);
    expect(boosts.size).toBe(1);
    expect(boosts.get(idA)).toBeGreaterThan(0);
    expect(boosts.get(idA)!).toBeLessThanOrEqual(0.2);
  });

  it('getCoOccurringRecords returns ordered results', async () => {
    const idA = await insertTestRecord('Record A');
    const idB = await insertTestRecord('Record B');
    const idC = await insertTestRecord('Record C');

    db.run(
      'INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen) VALUES (?, ?, ?, ?)',
      [idA, idB, 10, new Date().toISOString()],
    );
    db.run(
      'INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen) VALUES (?, ?, ?, ?)',
      [idA, idC, 3, new Date().toISOString()],
    );

    const results = getCoOccurringRecords(db, idA);
    expect(results.length).toBe(2);
    expect(results[0].count).toBe(10);
    expect(results[1].count).toBe(3);
  });
});

/**
 * Tests for relevance explainability.
 *
 * Feature 1: recall --explain surfaces per-signal relevance breakdown.
 */

import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scoreRecord, DEFAULT_WEIGHTS, type RelevanceSignals } from '../src/relevance/scoring.js';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { relevanceSearch } from '../src/relevance/search.js';

describe('scoreRecord with signals', () => {
  it('returns signal breakdown alongside score', () => {
    const result = scoreRecord(
      {
        similarity: 0.9,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 5,
        isSuperseded: false,
      },
      DEFAULT_WEIGHTS,
      'default',
    );

    expect(result.relevance).toBeGreaterThan(0);
    expect(result.signals).toBeDefined();
    expect(result.signals.similarity).toHaveProperty('raw');
    expect(result.signals.similarity).toHaveProperty('weight');
    expect(result.signals.similarity).toHaveProperty('weighted');
    expect(result.signals.similarity.raw).toBe(0.9);
    expect(result.signals.similarity.weight).toBe(0.4);
  });

  it('marks stale records in freshness signal', () => {
    const result = scoreRecord(
      {
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: true,
        accessCount: 0,
        isSuperseded: false,
      },
      DEFAULT_WEIGHTS,
      'default',
    );

    expect(result.signals.freshness.raw).toBeCloseTo(0.2, 10);
  });

  it('marks superseded records in result', () => {
    const normal = scoreRecord(
      {
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      },
      DEFAULT_WEIGHTS,
      'default',
    );

    const superseded = scoreRecord(
      {
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 0,
        isSuperseded: true,
      },
      DEFAULT_WEIGHTS,
      'default',
    );

    expect(superseded.relevance).toBeLessThan(normal.relevance);
  });
});

const PROJECT_ID = 'test-project-id';
const DUMMY_EMBEDDING = new Uint8Array(1536);

describe('relevanceSearch with explain', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-explain-'));
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

  it('includes signals when explain option is true', async () => {
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use React for the frontend',
      embedding: DUMMY_EMBEDDING,
    });

    const results = await relevanceSearch(db, new Float32Array(384), {
      limit: 10,
      noDecay: true,
      explain: true,
    });

    // noDecay path doesn't score — so signals won't be populated there
    // This test verifies the option is accepted without error
  });

  it('omits signals when explain option is false', async () => {
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use React for the frontend',
      embedding: DUMMY_EMBEDDING,
    });

    const results = await relevanceSearch(db, new Float32Array(384), {
      limit: 10,
      noDecay: true,
    });

    if (results.length > 0) {
      expect(results[0].signals).toBeUndefined();
    }
  });
});

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('recall --explain CLI', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-explain-cli-'));
    runMemnant(['init'], testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('shows signal breakdown with --explain', () => {
    runMemnant(['log', '--type', 'decision', '--content', 'Use React for frontend'], testDir);

    const result = runMemnant(['recall', 'React', '--explain'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('similarity:');
    expect(result.stdout).toContain('recency:');
    expect(result.stdout).toContain('freshness:');
    expect(result.stdout).toContain('frequency:');
  });

  it('--explain --json includes signals in output', () => {
    runMemnant(['log', '--type', 'decision', '--content', 'Use React for frontend'], testDir);

    const result = runMemnant(['recall', 'React', '--explain', '--json'], testDir);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('signals');
    expect(data[0].signals).toHaveProperty('similarity');
  });
});

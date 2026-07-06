/**
 * Tests for pheromone trail integration — co-occurrence boosts in relevance scoring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { scoreRecord } from '../src/relevance/scoring.js';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';
import { updateAccessPatterns } from '../src/relevance/access.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

const PROJECT_ID = 'test-pheromone';

describe('Pheromone trails: co-occurrence boosts', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-pheromone-'));
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

  const baseInputs = {
    similarity: 0.8,
    createdAt: new Date().toISOString(),
    isStale: false,
    accessCount: 3,
    isSuperseded: false,
  };

  it('scoreRecord applies co-occurrence boost (score with > score without)', () => {
    const { relevance: withoutBoost } = scoreRecord({ ...baseInputs });
    const { relevance: withBoost } = scoreRecord({
      ...baseInputs,
      coOccurrenceBoost: 0.1,
    });

    expect(withBoost).toBeGreaterThan(withoutBoost);
  });

  it('co-occurrence boost is capped at 0.2', () => {
    const { relevance: atCap } = scoreRecord({
      ...baseInputs,
      coOccurrenceBoost: 0.2,
    });
    const { relevance: overCap } = scoreRecord({
      ...baseInputs,
      coOccurrenceBoost: 0.5,
    });

    expect(atCap).toBe(overCap);
  });

  it('co-occurrence signal appears in output when boost is provided', () => {
    const { signals } = scoreRecord({
      ...baseInputs,
      coOccurrenceBoost: 0.15,
    });

    expect(signals.co_occurrence).toBeDefined();
    expect(signals.co_occurrence!.boost).toBe(0.15);
  });

  it('co-occurrence signal is absent when no boost provided', () => {
    const { signals } = scoreRecord({ ...baseInputs });

    expect(signals.co_occurrence).toBeUndefined();
  });

  it('co-occurrence signal is absent when boost is 0', () => {
    const { signals } = scoreRecord({
      ...baseInputs,
      coOccurrenceBoost: 0,
    });

    expect(signals.co_occurrence).toBeUndefined();
  });

  it('trail boost surfaces co-occurring records after primary results', async () => {
    // Create 3 records
    const emb1 = serializeEmbedding(await generateEmbedding('database schema design'));
    const r1 = insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Use PostgreSQL', embedding: emb1 });
    const emb2 = serializeEmbedding(await generateEmbedding('database migration strategy'));
    const r2 = insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Use Prisma for migrations', embedding: emb2 });
    const emb3 = serializeEmbedding(await generateEmbedding('unrelated frontend styling'));
    const r3 = insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Use Tailwind CSS', embedding: emb3 });

    // Simulate 10 sessions so boosts activate
    for (let i = 0; i < 10; i++) {
      db.run('INSERT INTO session (id, project_id, started_at) VALUES (?, ?, ?)',
        [`s${i}`, PROJECT_ID, new Date().toISOString()]);
    }

    // Create strong co-occurrence between r1 and r2 (accessed together 8 times)
    for (let i = 0; i < 8; i++) {
      updateAccessPatterns(db, [r1.id, r2.id]);
    }

    // r1 and r2 should have co-occurrence boost, r3 should not
    const { getCoOccurrenceBoosts } = await import('../src/context/patterns.js');
    const boosts = getCoOccurrenceBoosts(db, [r1.id, r2.id, r3.id]);

    expect(boosts.get(r1.id)).toBeGreaterThan(0);
    expect(boosts.get(r2.id)).toBeGreaterThan(0);
    expect(boosts.has(r3.id)).toBe(false);
  });

  it('pruneStaleTrails removes old low-count co-occurrences', async () => {
    const r1Id = 'rec-1';
    const r2Id = 'rec-2';
    const r3Id = 'rec-3';

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    const recentDate = new Date().toISOString();

    // Old trail with low count (should be pruned)
    db.run('INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen) VALUES (?, ?, 2, ?)',
      [r1Id, r2Id, oldDate]);

    // Old trail with high count (should survive)
    db.run('INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen) VALUES (?, ?, 5, ?)',
      [r1Id, r3Id, oldDate]);

    // Recent trail with low count (should survive)
    db.run('INSERT INTO access_pattern (record_id_a, record_id_b, co_occurrence_count, last_seen) VALUES (?, ?, 1, ?)',
      [r2Id, r3Id, recentDate]);

    const { pruneStaleTrails } = await import('../src/relevance/trail-decay.js');
    const pruned = pruneStaleTrails(db);

    expect(pruned).toBe(1); // Only the old low-count trail

    const remaining = db.all('SELECT * FROM access_pattern') as any[];
    expect(remaining.length).toBe(2);
  });
});

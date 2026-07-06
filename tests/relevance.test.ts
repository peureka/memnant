/**
 * Tests for Epic 10: Relevance Decay.
 *
 * Story 10.1: Relevance scoring model.
 * Story 10.2: Access tracking.
 * Story 10.4: Decay profiles.
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
import { scoreRecord, DEFAULT_WEIGHTS } from '../src/relevance/scoring.js';
import { trackAccess, getAccessCount, getAccessCounts, updateAccessPatterns } from '../src/relevance/access.js';
import { relevanceSearch } from '../src/relevance/search.js';
import { getHalfLifeDays, DECAY_PROFILES } from '../src/relevance/profiles.js';

const PROJECT_ID = 'test-project-id';

describe('Epic 10: Relevance Decay', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-relevance-'));
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

  describe('Story 10.1: Relevance scoring model', () => {
    it('returns a score between 0 and 1 for typical inputs', () => {
      const { relevance: score } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 3,
        isSuperseded: false,
      });

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('penalizes stale records', () => {
      const { relevance: fresh } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      });

      const { relevance: stale } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: true,
        accessCount: 0,
        isSuperseded: false,
      });

      expect(fresh).toBeGreaterThan(stale);
    });

    it('penalizes superseded records with 0.5x multiplier', () => {
      const { relevance: active } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 5,
        isSuperseded: false,
      });

      const { relevance: superseded } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 5,
        isSuperseded: true,
      });

      expect(superseded).toBeCloseTo(active * 0.5, 2);
    });

    it('older records score lower (recency decay)', () => {
      const { relevance: recent } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      });

      const { relevance: old } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      });

      expect(recent).toBeGreaterThan(old);
    });

    it('frequently accessed records score higher', () => {
      const { relevance: neverAccessed } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      });

      const { relevance: frequentlyAccessed } = scoreRecord({
        similarity: 0.8,
        createdAt: new Date().toISOString(),
        isStale: false,
        accessCount: 10,
        isSuperseded: false,
      });

      expect(frequentlyAccessed).toBeGreaterThan(neverAccessed);
    });
  });

  describe('Story 10.2: Access tracking', () => {
    it('tracks record access', () => {
      const recordId = 'test-record-1';
      // Insert a dummy record for foreign key
      db.run(
        "INSERT INTO record (id, project_id, type, content, content_text, created_at) VALUES (?, ?, 'decision', '{}', 'test', ?)",
        [recordId, PROJECT_ID, new Date().toISOString()],
      );

      trackAccess(db, [recordId], 'recall');
      trackAccess(db, [recordId], 'session_context');

      const count = getAccessCount(db, recordId);
      expect(count).toBe(2);
    });

    it('getAccessCounts handles multiple records', () => {
      const ids = ['rec-1', 'rec-2', 'rec-3'];
      for (const id of ids) {
        db.run(
          "INSERT INTO record (id, project_id, type, content, content_text, created_at) VALUES (?, ?, 'decision', '{}', 'test', ?)",
          [id, PROJECT_ID, new Date().toISOString()],
        );
      }

      trackAccess(db, ['rec-1'], 'recall');
      trackAccess(db, ['rec-1'], 'recall');
      trackAccess(db, ['rec-2'], 'recall');

      const counts = getAccessCounts(db, ids);
      expect(counts.get('rec-1')).toBe(2);
      expect(counts.get('rec-2')).toBe(1);
      expect(counts.has('rec-3')).toBe(false);
    });

    it('updateAccessPatterns creates co-occurrence records', () => {
      const ids = ['rec-a', 'rec-b', 'rec-c'];
      for (const id of ids) {
        db.run(
          "INSERT INTO record (id, project_id, type, content, content_text, created_at) VALUES (?, ?, 'decision', '{}', 'test', ?)",
          [id, PROJECT_ID, new Date().toISOString()],
        );
      }

      updateAccessPatterns(db, ids);

      const row = db.get(
        'SELECT co_occurrence_count FROM access_pattern WHERE record_id_a = ? AND record_id_b = ?',
        ['rec-a', 'rec-b'],
      ) as unknown as { co_occurrence_count: number } | undefined;

      expect(row).toBeTruthy();
      expect(row!.co_occurrence_count).toBe(1);

      // Second access bumps count
      updateAccessPatterns(db, ['rec-a', 'rec-b']);
      const row2 = db.get(
        'SELECT co_occurrence_count FROM access_pattern WHERE record_id_a = ? AND record_id_b = ?',
        ['rec-a', 'rec-b'],
      ) as unknown as { co_occurrence_count: number };
      expect(row2.co_occurrence_count).toBe(2);
    });
  });

  describe('Story 10.4: Decay profiles', () => {
    it('fast profile has 14-day half-life', () => {
      expect(getHalfLifeDays('fast')).toBe(14);
    });

    it('default profile has 30-day half-life', () => {
      expect(getHalfLifeDays('default')).toBe(30);
    });

    it('slow profile has 90-day half-life', () => {
      expect(getHalfLifeDays('slow')).toBe(90);
    });

    it('unknown profile falls back to default', () => {
      expect(getHalfLifeDays('unknown')).toBe(30);
    });

    it('fast decay penalizes old records more than slow', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const { relevance: fastScore } = scoreRecord({
        similarity: 0.8,
        createdAt: thirtyDaysAgo,
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      }, DEFAULT_WEIGHTS, 'fast');

      const { relevance: slowScore } = scoreRecord({
        similarity: 0.8,
        createdAt: thirtyDaysAgo,
        isStale: false,
        accessCount: 0,
        isSuperseded: false,
      }, DEFAULT_WEIGHTS, 'slow');

      expect(slowScore).toBeGreaterThan(fastScore);
    });
  });

  describe('Relevance search integration', () => {
    it('returns scored records sorted by relevance', async () => {
      const embedding1 = await generateEmbedding('database architecture decision');
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'decision',
        contentText: 'We chose PostgreSQL for the database layer',
        embedding: serializeEmbedding(embedding1),
      });

      const embedding2 = await generateEmbedding('frontend framework choice');
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'decision',
        contentText: 'React selected for frontend development',
        embedding: serializeEmbedding(embedding2),
      });

      const queryEmbedding = await generateEmbedding('database decision');
      const results = await relevanceSearch(db, queryEmbedding, {
        limit: 10,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('relevance');
      expect(results[0]).toHaveProperty('is_stale');
      expect(results[0]).toHaveProperty('is_superseded');

      // Results should be sorted by relevance descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].relevance).toBeGreaterThanOrEqual(results[i].relevance);
      }
    });

    it('noDecay returns raw similarity scores', async () => {
      const embedding = await generateEmbedding('test query content');
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'decision',
        contentText: 'test query content for recall',
        embedding: serializeEmbedding(embedding),
      });

      const queryEmbedding = await generateEmbedding('test query');
      const results = await relevanceSearch(db, queryEmbedding, {
        limit: 10,
        noDecay: true,
      });

      if (results.length > 0) {
        expect(results[0].relevance).toBe(results[0].similarity);
      }
    });
  });
});

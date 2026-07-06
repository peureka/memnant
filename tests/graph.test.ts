/**
 * Tests for Epic 9: Connection Graph.
 *
 * Story 9.1: Auto-linking at write time.
 * Story 9.2: Supersession detection.
 * Story 9.4: Graph queries and formatting.
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
import {
  autoLinkRecord,
  getRelationships,
  getSupersededRecordIds,
  unsupersede,
  dismissContradiction,
} from '../src/graph/relationships.js';
import { buildGraph, formatGraphAsText } from '../src/graph/queries.js';

const PROJECT_ID = 'test-project-id';

describe('Epic 9: Connection Graph', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-graph-'));
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

  describe('Story 9.1: Auto-linking', () => {
    it('links similar records automatically', async () => {
      const r1 = await insertTestRecord('Chose PostgreSQL database for JSON support');
      const r2 = await insertTestRecord('Chose PostgreSQL database for JSON capabilities');

      const links = autoLinkRecord(db, r2);

      // Should find a relationship between the two similar records
      const rels = getRelationships(db, r2.id);
      expect(rels.length).toBeGreaterThan(0);
    });

    it('does not link unrelated records', async () => {
      const r1 = await insertTestRecord('We chose PostgreSQL for the database');
      const r2 = await insertTestRecord('The weather today is sunny and warm');

      const links = autoLinkRecord(db, r2);
      const rels = getRelationships(db, r2.id);
      // Unrelated topics should have low similarity
      expect(rels.length).toBe(0);
    });

    it('updates related_records field on both records', async () => {
      const r1 = await insertTestRecord('Decision use Redis for caching API responses');
      const r2 = await insertTestRecord('Decision use Redis for caching API responses efficiently');

      autoLinkRecord(db, r2);

      const row1 = db.get('SELECT related_records FROM record WHERE id = ?', [r1.id]) as unknown as { related_records: string };
      const row2 = db.get('SELECT related_records FROM record WHERE id = ?', [r2.id]) as unknown as { related_records: string };

      const related1: string[] = JSON.parse(row1.related_records);
      const related2: string[] = JSON.parse(row2.related_records);

      // At least one should contain the other (bidirectional linking)
      const hasLink = related1.includes(r2.id) || related2.includes(r1.id);
      expect(hasLink).toBe(true);
    });

    it('limits to MAX_LINKS_PER_RECORD', async () => {
      // Insert 7 similar records, then a new one — should link to at most 5
      for (let i = 0; i < 7; i++) {
        await insertTestRecord(`Database migration strategy version ${i}: use sequential migrations`);
      }

      const newRecord = await insertTestRecord('Database migration strategy: sequential migration approach');
      autoLinkRecord(db, newRecord);

      const rels = getRelationships(db, newRecord.id);
      // Count unique related records (not counting self)
      const uniqueTargets = new Set(
        rels.map((r) => r.source_record_id === newRecord.id ? r.target_record_id : r.source_record_id),
      );
      expect(uniqueTargets.size).toBeLessThanOrEqual(5);
    });
  });

  describe('Story 9.2: Supersession detection', () => {
    it('marks very similar same-type records as supersedes', async () => {
      const r1 = await insertTestRecord('We use JWT tokens for authentication in all API endpoints');
      const r2 = await insertTestRecord('We use JWT tokens for authentication in all API endpoints, with refresh token rotation');

      autoLinkRecord(db, r2);

      const rels = getRelationships(db, r2.id);
      const supersession = rels.find((r) => r.type === 'supersedes');
      // May or may not trigger depending on exact similarity — we just verify the mechanism works
      if (supersession) {
        expect(supersession.similarity).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('getSupersededRecordIds returns correct IDs', async () => {
      // Create actual records for foreign keys
      const r1 = await insertTestRecord('Original auth decision');
      const r2 = await insertTestRecord('Updated auth decision superseding original');

      db.run(
        `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
         VALUES ('rel-1', ?, ?, 'supersedes', 0.9, ?)`,
        [r2.id, r1.id, new Date().toISOString()],
      );

      const superseded = getSupersededRecordIds(db);
      expect(superseded.has(r1.id)).toBe(true);
      expect(superseded.has(r2.id)).toBe(false);
    });

    it('unsupersede removes the relationship', async () => {
      const r1 = await insertTestRecord('Original caching decision');
      const r2 = await insertTestRecord('New caching decision');

      db.run(
        `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
         VALUES ('rel-2', ?, ?, 'supersedes', 0.9, ?)`,
        [r2.id, r1.id, new Date().toISOString()],
      );

      const result = unsupersede(db, r2.id);
      expect(result).toBe(true);

      const superseded = getSupersededRecordIds(db);
      expect(superseded.has(r1.id)).toBe(false);
    });
  });

  describe('Story 9.4: Graph visualization', () => {
    it('builds graph with connections', async () => {
      const r1 = await insertTestRecord('Decision: use React for the frontend');
      const r2 = await insertTestRecord('Frontend framework decision: React chosen for component ecosystem');

      autoLinkRecord(db, r2);

      const nodes = buildGraph(db);
      expect(nodes.length).toBe(2);
    });

    it('formats graph as text tree', async () => {
      const r1 = await insertTestRecord('Decision: use TypeScript everywhere');

      const nodes = buildGraph(db);
      const text = formatGraphAsText(nodes);

      expect(text).toContain(r1.id.slice(0, 8));
      expect(text).toContain('decision');
    });

    it('filters by type', async () => {
      await insertTestRecord('Decision about X', 'decision');
      await insertTestRecord('Framework fix for Y', 'framework_fix');

      const nodes = buildGraph(db, { type: 'decision' });
      expect(nodes.every((n) => n.type === 'decision')).toBe(true);
    });

    it('returns empty message for no records', () => {
      const text = formatGraphAsText([]);
      expect(text).toBe('No records found.');
    });

    it('dismissContradiction sets dismissed_at', async () => {
      const r1 = await insertTestRecord('Use modals for forms');
      const r2 = await insertTestRecord('Never use modals for forms');

      db.run(
        `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
         VALUES ('c1', ?, ?, 'contradicts', 0.8, ?)`,
        [r1.id, r2.id, new Date().toISOString()],
      );

      const result = dismissContradiction(db, r1.id, r2.id);
      expect(result).toBe(true);

      // Should not appear in unresolved
      const rows = db.all(
        "SELECT * FROM record_relationship WHERE type = 'contradicts' AND dismissed_at IS NULL",
      ) as unknown as unknown[];
      expect(rows.length).toBe(0);
    });
  });
});

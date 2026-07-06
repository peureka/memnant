import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clusterRecords, type ClusterInput } from '../src/patterns/cluster.js';
import { summarizeClusterTemplate } from '../src/patterns/summarize.js';
import { generateProfile } from '../src/patterns/profile.js';
import { openColonyDb } from '../src/colony/colony.js';
import type { Cluster } from '../src/patterns/cluster.js';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createDatabase } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding } from '../src/vector/embeddings.js';
import { serializeEmbedding } from '../src/vector/embedding-utils.js';
import { detectPatterns } from '../src/patterns/detect.js';

describe('union-find clustering', () => {
  it('groups records with similarity >= threshold', () => {
    const dim = 384;
    const baseA = new Float32Array(dim).fill(0);
    baseA[0] = 1.0;

    const baseB = new Float32Array(dim).fill(0);
    baseB[0] = 0.99; baseB[1] = 0.14;

    const baseC = new Float32Array(dim).fill(0);
    baseC[0] = 0.98; baseC[2] = 0.20;

    const outlier = new Float32Array(dim).fill(0);
    outlier[100] = 1.0;

    const records: ClusterInput[] = [
      { id: 'r1', project_id: 'p1', type: 'decision', content_text: 'A', tags: ['a'], embedding: baseA },
      { id: 'r2', project_id: 'p1', type: 'decision', content_text: 'B', tags: ['b'], embedding: baseB },
      { id: 'r3', project_id: 'p1', type: 'decision', content_text: 'C', tags: ['c'], embedding: baseC },
      { id: 'r4', project_id: 'p1', type: 'decision', content_text: 'D', tags: ['d'], embedding: outlier },
    ];

    const clusters = clusterRecords(records, 0.82);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].records).toHaveLength(3);
    expect(clusters[0].records.map(r => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('returns empty when no cluster reaches minimum size', () => {
    const dim = 384;
    const a = new Float32Array(dim).fill(0); a[0] = 1.0;
    const b = new Float32Array(dim).fill(0); b[100] = 1.0;

    const records: ClusterInput[] = [
      { id: 'r1', project_id: 'p1', type: 'decision', content_text: 'A', tags: [], embedding: a },
      { id: 'r2', project_id: 'p1', type: 'decision', content_text: 'B', tags: [], embedding: b },
    ];

    const clusters = clusterRecords(records, 0.82);
    expect(clusters).toEqual([]);
  });

  it('merges overlapping groups via union-find', () => {
    const dim = 384;
    const a = new Float32Array(dim).fill(0); a[0] = 1.0;
    const b = new Float32Array(dim).fill(0); b[0] = 0.85; b[1] = 0.53;
    const c = new Float32Array(dim).fill(0); c[0] = 0.60; c[1] = 0.80;

    const records: ClusterInput[] = [
      { id: 'r1', project_id: 'p1', type: 'decision', content_text: 'A', tags: [], embedding: a },
      { id: 'r2', project_id: 'p1', type: 'decision', content_text: 'B', tags: [], embedding: b },
      { id: 'r3', project_id: 'p1', type: 'decision', content_text: 'C', tags: [], embedding: c },
    ];

    const clusters = clusterRecords(records, 0.82);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].records).toHaveLength(3);
  });
});

describe('pattern summarization', () => {
  it('generates template summary for decision cluster', () => {
    const cluster: Cluster = {
      records: [
        { id: 'r1', project_id: 'p1', type: 'decision', content_text: 'Chose Postgres over MySQL for analytics', tags: ['postgres'], embedding: new Float32Array(1) },
        { id: 'r2', project_id: 'p2', type: 'decision', content_text: 'Using Postgres instead of MySQL for reporting', tags: ['postgres'], embedding: new Float32Array(1) },
        { id: 'r3', project_id: 'p3', type: 'decision', content_text: 'Picked Postgres over MySQL for data warehouse', tags: ['postgres'], embedding: new Float32Array(1) },
      ],
      centroidText: 'Chose Postgres over MySQL for analytics',
      tags: ['postgres'],
    };

    const summary = summarizeClusterTemplate(cluster);
    expect(summary).toContain('3');
    expect(summary.length).toBeGreaterThan(10);
    expect(summary.length).toBeLessThan(200);
  });

  it('generates template summary for framework_fix cluster', () => {
    const cluster: Cluster = {
      records: [
        { id: 'r1', project_id: 'p1', type: 'framework_fix', content_text: 'useSearchParams needs Suspense boundary', tags: ['nextjs'], embedding: new Float32Array(1) },
        { id: 'r2', project_id: 'p2', type: 'framework_fix', content_text: 'useSearchParams requires Suspense wrapper', tags: ['nextjs'], embedding: new Float32Array(1) },
        { id: 'r3', project_id: 'p3', type: 'framework_fix', content_text: 'Suspense needed for useSearchParams', tags: ['nextjs'], embedding: new Float32Array(1) },
      ],
      centroidText: 'useSearchParams needs Suspense boundary',
      tags: ['nextjs'],
    };

    const summary = summarizeClusterTemplate(cluster);
    expect(summary).toContain('3');
    expect(summary).toContain('project');
  });

  it('counts unique projects', () => {
    const cluster: Cluster = {
      records: [
        { id: 'r1', project_id: 'p1', type: 'decision', content_text: 'Use Tailwind', tags: [], embedding: new Float32Array(1) },
        { id: 'r2', project_id: 'p1', type: 'decision', content_text: 'Tailwind chosen', tags: [], embedding: new Float32Array(1) },
        { id: 'r3', project_id: 'p2', type: 'decision', content_text: 'Going with Tailwind', tags: [], embedding: new Float32Array(1) },
      ],
      centroidText: 'Use Tailwind',
      tags: [],
    };

    const summary = summarizeClusterTemplate(cluster);
    expect(summary).toContain('2 project');
  });
});

describe('living profile generation', () => {
  it('generates markdown profile from pattern records', () => {
    const testDir2 = join(tmpdir(), 'memnant-profile-' + Date.now());
    mkdirSync(testDir2, { recursive: true });
    const colonyPath = join(testDir2, 'colony.db');
    const colonyDb = openColonyDb(colonyPath);

    const now = new Date().toISOString();
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, pattern_strength, pattern_last_seen, supporting_records, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pat-1', 'colony', 'pattern', '{}', 'Prefers Postgres over MySQL for analytics (4 decisions across 3 projects)', '["postgres"]', '[]', now, 5, now, '[]', null]
    );
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, pattern_strength, pattern_last_seen, supporting_records, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pat-2', 'colony', 'pattern', '{}', 'useSearchParams needs Suspense boundary (seen in 3 projects, 4 occurrences)', '["nextjs"]', '[]', now, 6, now, '[]', null]
    );
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, pattern_strength, pattern_last_seen, supporting_records, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['pat-3', 'colony', 'pattern', '{}', 'Weak pattern', '[]', '[]', now, 3, now, '[]', null]
    );

    const profile = generateProfile(colonyDb);
    expect(profile).toContain('Postgres');
    expect(profile).toContain('Suspense');
    expect(profile).not.toContain('Weak pattern');
    expect(profile).toContain('# memnant');

    colonyDb.close();
    rmSync(testDir2, { recursive: true, force: true });
  });

  it('returns empty string when no patterns qualify', () => {
    const testDir2 = join(tmpdir(), 'memnant-profile-empty-' + Date.now());
    mkdirSync(testDir2, { recursive: true });
    const colonyPath = join(testDir2, 'colony.db');
    const colonyDb = openColonyDb(colonyPath);

    const profile = generateProfile(colonyDb);
    expect(profile).toBe('');

    colonyDb.close();
    rmSync(testDir2, { recursive: true, force: true });
  });
});

describe('pattern detection', () => {
  const testDir = join(tmpdir(), 'memnant-patterns-detect-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('detects a pattern from 3+ similar records', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const colonyPath = join(testDir, 'colony.db');
    const db = createDatabase(dbPath);
    const colonyDb = openColonyDb(colonyPath);

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );

    const texts = [
      'We chose Postgres over MySQL',
      'We picked Postgres over MySQL',
      'We selected Postgres over MySQL',
    ];

    for (const text of texts) {
      const embedding = await generateEmbedding(text);
      insertRecord(db, {
        projectId: 'test-project',
        type: 'decision',
        contentText: text,
        embedding: serializeEmbedding(embedding),
        tags: ['postgres'],
      });
    }

    const result = await detectPatterns(db, colonyDb);
    expect(result.patternsCreated + result.patternsUpdated).toBeGreaterThanOrEqual(1);

    const patterns = colonyDb.all("SELECT * FROM record WHERE type = 'pattern'");
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].pattern_strength).toBeGreaterThanOrEqual(3);

    db.close();
    colonyDb.close();
  }, 30000);

  it('updates existing pattern when cluster matches', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const colonyPath = join(testDir, 'colony.db');
    const db = createDatabase(dbPath);
    const colonyDb = openColonyDb(colonyPath);

    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );

    const texts = [
      'We chose Postgres over MySQL',
      'We picked Postgres over MySQL',
      'We selected Postgres over MySQL',
    ];

    for (const text of texts) {
      const embedding = await generateEmbedding(text);
      insertRecord(db, {
        projectId: 'test-project',
        type: 'decision',
        contentText: text,
        embedding: serializeEmbedding(embedding),
        tags: ['postgres'],
      });
    }

    await detectPatterns(db, colonyDb);
    const firstPatterns = colonyDb.all("SELECT * FROM record WHERE type = 'pattern'");
    const firstStrength = firstPatterns[0].pattern_strength;

    const embedding = await generateEmbedding('Postgres was chosen over MySQL');
    insertRecord(db, {
      projectId: 'test-project',
      type: 'decision',
      contentText: 'Postgres was chosen over MySQL',
      embedding: serializeEmbedding(embedding),
      tags: ['postgres'],
    });

    await detectPatterns(db, colonyDb);
    const secondPatterns = colonyDb.all("SELECT * FROM record WHERE type = 'pattern'");
    expect(secondPatterns.length).toBe(firstPatterns.length);
    expect(secondPatterns[0].pattern_strength).toBeGreaterThan(firstStrength);

    db.close();
    colonyDb.close();
  }, 60000);
});

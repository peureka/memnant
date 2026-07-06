import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, openDatabase } from '../src/ledger/database.js';
import { openColonyDb, getColonyDbPath } from '../src/colony/colony.js';
import { promoteToColony, isDuplicate, shouldAutoPromote } from '../src/colony/promote.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding } from '../src/vector/embeddings.js';
import { serializeEmbedding } from '../src/vector/embedding-utils.js';
import { promoteRecordById } from '../src/cli/promote.js';

describe('colony schema', () => {
  const testDir = join(tmpdir(), 'memnant-colony-test-' + Date.now());
  const dbPath = join(testDir, 'ledger.db');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates database with colony provenance columns', () => {
    const db = createDatabase(dbPath);
    const info = db.all("PRAGMA table_info(record)");
    const columns = info.map((r: any) => r.name);
    expect(columns).toContain('source_project_id');
    expect(columns).toContain('source_record_id');
    db.close();
  });

  it('migrates existing database to v8', () => {
    const db = createDatabase(dbPath);
    db.close();
    const db2 = openDatabase(dbPath);
    const info = db2.all("PRAGMA table_info(record)");
    const columns = info.map((r: any) => r.name);
    expect(columns).toContain('source_project_id');
    expect(columns).toContain('source_record_id');
    db2.close();
  });
});

describe('colony database', () => {
  const testDir = join(tmpdir(), 'memnant-colony-db-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('getColonyDbPath returns ~/.memnant/colony.db', () => {
    const path = getColonyDbPath();
    expect(path).toContain('.memnant');
    expect(path).toContain('colony.db');
  });

  it('openColonyDb creates colony database if missing', () => {
    const colonyDir = join(testDir, '.memnant');
    const colonyPath = join(colonyDir, 'colony.db');
    const db = openColonyDb(colonyPath);
    expect(existsSync(colonyPath)).toBe(true);
    db.close();
  });
});

describe('colony promotion', () => {
  const testDir = join(tmpdir(), 'memnant-colony-promote-test-' + Date.now());
  const dbPath = join(testDir, 'ledger.db');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('promotes a framework_fix to colony', async () => {
    const projectDb = createDatabase(dbPath);
    projectDb.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );
    const colonyPath = join(testDir, 'colony.db');
    const colonyDb = openColonyDb(colonyPath);

    const embedding = await generateEmbedding('Next.js 15 useSearchParams needs Suspense boundary');
    const embeddingBuffer = serializeEmbedding(embedding);

    const record = insertRecord(projectDb, {
      projectId: 'test-project',
      type: 'framework_fix',
      contentText: 'Next.js 15 useSearchParams needs Suspense boundary',
      embedding: embeddingBuffer,
      tags: ['nextjs'],
    });

    const promoted = await promoteToColony(colonyDb, record, 'test-project');
    expect(promoted).not.toBeNull();
    expect(promoted!.source_project_id).toBe('test-project');
    expect(promoted!.source_record_id).toBe(record.id);

    projectDb.close();
    colonyDb.close();
  }, 30000);

  it('skips duplicate by embedding similarity', async () => {
    const colonyPath = join(testDir, 'colony2.db');
    const colonyDb = openColonyDb(colonyPath);

    const embedding = await generateEmbedding('Next.js useSearchParams Suspense fix');

    const record1 = {
      id: 'r1',
      project_id: 'p1',
      type: 'framework_fix' as const,
      content: { text: 'Next.js useSearchParams Suspense fix' },
      content_text: 'Next.js useSearchParams Suspense fix',
      embedding: embedding,
      tags: ['nextjs'],
      related_records: [],
      created_at: new Date().toISOString(),
      source_session: null,
      staleness_marker: null,
      retracted_at: null,
      retracted_reason: null,
      archived_at: null,
      target_file: null,
      target_symbol: null,
      ast_hash: null,
      embedding_model: null,
    };
    await promoteToColony(colonyDb, record1, 'p1');

    // Try to detect near-duplicate
    const dup = isDuplicate(colonyDb, embedding, 0.92);
    expect(dup).toBe(true);

    colonyDb.close();
  }, 30000);
});

describe('auto-promotion rules', () => {
  it('promotes framework_fix records', () => {
    expect(shouldAutoPromote('framework_fix', [])).toBe(true);
  });

  it('promotes rejected decisions', () => {
    expect(shouldAutoPromote('decision', ['rejected'])).toBe(true);
  });

  it('does not promote regular decisions', () => {
    expect(shouldAutoPromote('decision', ['architecture'])).toBe(false);
  });

  it('does not promote session_logs', () => {
    expect(shouldAutoPromote('session_log', [])).toBe(false);
  });

  it('does not promote spec_snapshots', () => {
    expect(shouldAutoPromote('spec_snapshot', [])).toBe(false);
  });
});

describe('memnant promote CLI', () => {
  const testDir = join(tmpdir(), 'memnant-colony-promote-cli-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('promotes a specific record by ID', async () => {
    const dbPath = join(testDir, 'promote-test.db');
    const projectDb = createDatabase(dbPath);
    projectDb.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );
    const colonyPath = join(testDir, 'promote-colony.db');
    const colonyDb = openColonyDb(colonyPath);

    const embedding = await generateEmbedding('Custom architecture decision');
    const embeddingBuffer = serializeEmbedding(embedding);

    const record = insertRecord(projectDb, {
      projectId: 'test-project',
      type: 'decision',
      contentText: 'Custom architecture decision worth promoting',
      embedding: embeddingBuffer,
      tags: ['architecture'],
    });

    const result = await promoteRecordById(projectDb, colonyDb, record.id, 'test-project');
    expect(result.promoted).toBe(true);

    // Verify it's in colony
    const rows = colonyDb.all("SELECT * FROM record WHERE source_record_id = ?", [record.id]);
    expect(rows.length).toBe(1);

    projectDb.close();
    colonyDb.close();
  }, 30000);

  it('rejects promotion of non-existent record', async () => {
    const dbPath = join(testDir, 'promote-test2.db');
    const projectDb = createDatabase(dbPath);
    const colonyPath = join(testDir, 'promote-colony2.db');
    const colonyDb = openColonyDb(colonyPath);

    const result = await promoteRecordById(projectDb, colonyDb, 'nonexistent', 'test-project');
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('not found');

    projectDb.close();
    colonyDb.close();
  }, 30000);
});

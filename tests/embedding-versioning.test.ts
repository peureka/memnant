/**
 * Tests for Embedding Versioning & Reindex.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { MODEL_NAME } from '../src/vector/embeddings.js';
import { searchRecords } from '../src/vector/search.js';
import { getLedgerStats } from '../src/ledger/stats.js';

describe('Embedding Versioning', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-embed-version-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES ('test-proj', 'test', '/tmp/test', '2025-01-01T00:00:00.000Z')",
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('stores embedding_model on insert with current MODEL_NAME', () => {
    const embedding = new Float32Array(384).fill(0.1);
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const record = insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Test decision',
      embedding: buffer,
    });

    const row = db.get('SELECT embedding_model FROM record WHERE id = ?', [record.id]) as unknown as { embedding_model: string };
    expect(row.embedding_model).toBe(MODEL_NAME);
  });

  it('record object includes embedding_model field', () => {
    const embedding = new Float32Array(384).fill(0.1);
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const record = insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Test decision',
      embedding: buffer,
    });

    expect(record.embedding_model).toBe(MODEL_NAME);
  });

  it('allows custom embedding_model for imported records', () => {
    const embedding = new Float32Array(384).fill(0.1);
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const record = insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Imported decision',
      embedding: buffer,
      embeddingModel: 'Xenova/all-MiniLM-L6-v1',
    });

    const row = db.get('SELECT embedding_model FROM record WHERE id = ?', [record.id]) as unknown as { embedding_model: string };
    expect(row.embedding_model).toBe('Xenova/all-MiniLM-L6-v1');
    expect(record.embedding_model).toBe('Xenova/all-MiniLM-L6-v1');
  });

  it('flags stale_embedding when record has mismatched embedding_model', () => {
    const embedding = new Float32Array(384).fill(0.1);
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // Insert with old model
    insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Old model decision',
      embedding: buffer,
      embeddingModel: 'Xenova/all-MiniLM-L6-v1',
    });

    // Insert with current model
    insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Current model decision',
      embedding: buffer,
    });

    const results = searchRecords(db, embedding, { limit: 10 });

    const oldResult = results.find((r) => r.content_text === 'Old model decision');
    const currentResult = results.find((r) => r.content_text === 'Current model decision');

    expect(oldResult).toBeDefined();
    expect(oldResult!.stale_embedding).toBe(true);
    expect(currentResult).toBeDefined();
    expect(currentResult!.stale_embedding).toBe(false);
  });

  it('stats reports embedding model and mismatch count', () => {
    const embedding = new Float32Array(384).fill(0.1);
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // Insert 2 current, 1 old
    insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Current 1',
      embedding: buffer,
    });
    insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Current 2',
      embedding: buffer,
    });
    insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Old model',
      embedding: buffer,
      embeddingModel: 'Xenova/all-MiniLM-L6-v1',
    });

    const stats = getLedgerStats(db);

    expect(stats.embeddings).toBeDefined();
    expect(stats.embeddings.currentModel).toBe(MODEL_NAME);
    expect(stats.embeddings.mismatchedCount).toBe(1);
    expect(stats.embeddings.totalWithEmbeddings).toBe(3);
  });

  it('reindex --dry-run reports mismatched count without changing records', async () => {
    const embedding = new Float32Array(384).fill(0.1);
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const record = insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Old model decision',
      embedding: buffer,
      embeddingModel: 'Xenova/all-MiniLM-L6-v1',
    });

    // Also insert a current one
    insertRecord(db, {
      projectId: 'test-proj',
      type: 'decision',
      contentText: 'Current decision',
      embedding: buffer,
    });

    const { reindexRecords } = await import('../src/vector/reindex.js');
    const result = await reindexRecords(db, { staleOnly: true, dryRun: true });

    expect(result.total).toBe(1);
    expect(result.reindexed).toBe(0);

    // Verify record was NOT changed
    const row = db.get('SELECT embedding_model FROM record WHERE id = ?', [record.id]) as unknown as { embedding_model: string };
    expect(row.embedding_model).toBe('Xenova/all-MiniLM-L6-v1');
  });
});

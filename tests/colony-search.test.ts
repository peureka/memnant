import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openColonyDb } from '../src/colony/colony.js';
import { searchColony } from '../src/colony/search.js';
import { generateEmbedding } from '../src/vector/embeddings.js';
import { serializeEmbedding } from '../src/vector/embedding-utils.js';

describe('colony search', () => {
  const testDir = join(tmpdir(), 'memnant-colony-search-' + Date.now());
  const colonyPath = join(testDir, 'colony.db');

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns colony results marked with [colony] source', async () => {
    const colonyDb = openColonyDb(colonyPath);

    // Insert a record directly
    const embedding = await generateEmbedding('React useEffect cleanup function');
    const embeddingBuffer = serializeEmbedding(embedding);
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, tags, related_records, created_at, source_project_id, source_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['test-id', 'colony', 'framework_fix', '{"text":"React useEffect cleanup"}', 'React useEffect cleanup function', embeddingBuffer, '["react"]', '[]', new Date().toISOString(), 'other-project', 'orig-id']
    );

    const queryEmbedding = await generateEmbedding('useEffect cleanup');
    const results = searchColony(colonyDb, queryEmbedding, { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('colony');
    expect(results[0].source_project_id).toBe('other-project');

    colonyDb.close();
  }, 30000);

  it('respects type filter', async () => {
    const colonyDb = openColonyDb(colonyPath);

    const embedding = await generateEmbedding('TypeScript strict mode configuration');
    const embeddingBuffer = serializeEmbedding(embedding);
    colonyDb.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, tags, related_records, created_at, source_project_id, source_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['type-test', 'colony', 'decision', '{"text":"TS strict mode"}', 'TypeScript strict mode configuration', embeddingBuffer, '["typescript"]', '[]', new Date().toISOString(), 'proj-1', 'rec-1']
    );

    const queryEmbedding = await generateEmbedding('TypeScript strict');

    // Without type filter — should find it
    const allResults = searchColony(colonyDb, queryEmbedding, { limit: 5 });
    expect(allResults.length).toBeGreaterThan(0);

    // With type filter for framework_fix — should not find it
    const fixResults = searchColony(colonyDb, queryEmbedding, { limit: 5, type: 'framework_fix' });
    expect(fixResults).toEqual([]);

    colonyDb.close();
  }, 30000);

  it('returns empty array when colony has no matching records', async () => {
    const colonyDb = openColonyDb(colonyPath);
    const queryEmbedding = await generateEmbedding('something completely unrelated xyz abc 123');
    const results = searchColony(colonyDb, queryEmbedding, { limit: 5 });
    expect(results).toEqual([]);
    colonyDb.close();
  }, 30000);
});

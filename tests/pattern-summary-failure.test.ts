/**
 * A failed cluster summarisation must be reported, not swallowed.
 *
 * detectPatterns wrapped summarizeCluster in a bare catch whose body was a lone
 * comment. Cluster summaries silently vanished on any model failure — bad pin,
 * auth error, rate limit — with no signal anywhere. This is the path that hid
 * two model generations of stale tier pins.
 *
 * Distinct from the repo's "best-effort" catches (colony search, trail pruning,
 * profile injection), which drop optional enhancements. This one drops the
 * output the function exists to produce.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { detectPatterns } from '../src/synthesis/patterns.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';
let dir: string;
let db: Database;

// Provider that does not exist, so callModel throws for every cluster.
function configWithBrokenModel(): ProjectConfig {
  return {
    project: { name: 'test', id: PROJECT_ID },
    memory: { db_path: '.memnant/ledger.db' },
    orchestrator: {
      tiers: {
        triage: { provider: 'nonexistent', model: 'x' },
        analysis: { provider: 'nonexistent', model: 'x' },
        build: { provider: 'nonexistent', model: 'x' },
      },
    },
  } as unknown as ProjectConfig;
}

describe('Pattern summarisation failure', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memnant-pat-'));
    db = createDatabase(join(dir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, dir, new Date().toISOString()]);
    // MIN_CLUSTER_SIZE is 3; share a tag so they cluster without embeddings.
    for (let i = 0; i < 4; i++) {
      insertRecord(db, {
        projectId: PROJECT_ID, type: 'decision',
        contentText: `Decision ${i}: use SQLite for the ledger`,
        tags: ['architecture'], embedding: Buffer.alloc(384 * 4),
      });
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports the failure rather than dropping the summary in silence', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const clusters = await detectPatterns(db, configWithBrokenModel());

    expect(clusters.length, 'needs at least one cluster to summarise').toBeGreaterThan(0);
    expect(clusters.every((c) => !c.summary), 'summaries should be absent').toBe(true);
    expect(errors, 'the failure must reach stderr').toHaveBeenCalled();
  });
});

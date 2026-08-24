/**
 * Tests that accrued model spend reaches the ledger at session close.
 *
 * `memnant costs` reads cost tags off orchestrator_task records. callModel
 * accrues spend but holds no database handle, so closeSession — the single
 * funnel all three close paths use — is where the spend is persisted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { createSession, closeSession } from '../src/ledger/sessions.js';
import { insertRecord } from '../src/ledger/records.js';
import { recordCost, drainCosts, parseCostFromRecord } from '../src/orchestrator/costs.js';
import { dotProduct } from '../src/vector/search.js';
import { deserializeEmbedding } from '../src/vector/embedding-utils.js';

const PROJECT_ID = 'test-project-id';
let dir: string;
let db: Database;

describe('Session cost drain', () => {
  beforeEach(() => {
    drainCosts();
    dir = mkdtempSync(join(tmpdir(), 'memnant-cost-'));
    db = createDatabase(join(dir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, dir, new Date().toISOString()]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function closeWithLog() {
    const session = createSession(db, PROJECT_ID);
    const log = insertRecord(db, {
      projectId: PROJECT_ID, type: 'session_log', contentText: 'done',
      embedding: Buffer.alloc(384 * 4),
    });
    closeSession(db, session.id, log.id);
    return session;
  }

  it('persists what the session spent, where the costs command reads it', () => {
    recordCost({ tier: 'analysis', model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 0, cost_usd: 5 });
    recordCost({ tier: 'triage', model: 'claude-haiku-4-5', input_tokens: 1_000_000, output_tokens: 0, cost_usd: 1 });

    const session = closeWithLog();

    // Same query shape as src/cli/costs.ts
    const rows = db.all(
      "SELECT content_text, source_session FROM record WHERE type IN ('orchestrator_task', 'synthesis_cache') AND retracted_at IS NULL",
    ) as unknown as Array<{ content_text: string; source_session: string | null }>;

    const parsed = rows.map((r) => parseCostFromRecord(r.content_text)).filter(Boolean);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p!.tier).sort()).toEqual(['analysis', 'triage']);
    expect(parsed.reduce((sum, p) => sum + p!.cost_usd, 0)).toBeCloseTo(6, 6);
    expect(rows.every((r) => r.source_session === session.id)).toBe(true);
  });

  it('keeps cost records out of recall results', () => {
    recordCost({ tier: 'analysis', model: 'claude-opus-5', input_tokens: 10, output_tokens: 5, cost_usd: 0.001 });
    closeWithLog();

    const row = db.get(
      "SELECT embedding FROM record WHERE type = 'orchestrator_task' LIMIT 1",
    ) as unknown as { embedding: Uint8Array };

    // A cost tag is machine-readable bookkeeping, not knowledge. Whatever a user
    // searches for, this must score below the recall similarity floor (0.3).
    const stored = deserializeEmbedding(row.embedding);
    const query = new Float32Array(384).fill(1 / Math.sqrt(384));
    expect(dotProduct(query, stored)).toBeLessThan(0.3);
  });

  it('writes nothing when the session spent nothing', () => {
    closeWithLog();

    const rows = db.all(
      "SELECT id FROM record WHERE type = 'orchestrator_task'",
    ) as unknown as Array<{ id: string }>;
    expect(rows).toHaveLength(0);
  });
});

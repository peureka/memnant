/**
 * Story S4 — best-effort wrapper.
 *
 * session_context runs every session; a throw inside choreography must
 * degrade to full context minus the process layer, never an error
 * (plan principle 5). compileContext is the function session_context calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

// Inject a throw into the choreography layer.
vi.mock('../src/context/choreography.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/context/choreography.js')>();
  return {
    ...actual,
    computeChoreography: () => {
      throw new Error('boom — injected choreography failure');
    },
  };
});

const PROJECT_ID = 'test-project';
const DUMMY = new Uint8Array(1536);

describe('Choreography best-effort degradation', () => {
  let testDir: string;
  let db: Database;
  let docsPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-choreo-be-'));
    docsPath = join(testDir, 'docs');
    await mkdir(docsPath, { recursive: true });
    db = createDatabase(join(testDir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)", [PROJECT_ID, testDir, new Date().toISOString()]);
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns full context minus the process layer when choreography throws', async () => {
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Chose JWT for the auth epic', tags: ['auth'], embedding: DUMMY });
    const { compileContext } = await import('../src/context/compile.js');

    const ctx = await compileContext(db, {
      epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID,
      choreography: { enabled: true, reviewTag: 'codex-review', stages: ['rejection'], reviewPressureDays: 90 },
    });

    // Did not throw; other sections intact; no process layer.
    expect(ctx.sections.process_guidance).toBeUndefined();
    expect(ctx.sections.epic_context).toContain('JWT');
    expect(ctx.token_estimate).toBeGreaterThan(0);
    expect(ctx.warnings).toBeDefined();
  });
});

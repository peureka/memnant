/**
 * Story S2 — Choreography wired into compileContext + markdown render.
 *
 * process_guidance appears in the compiled context when nudges exist,
 * is omitted when none, renders as a terse markdown section, and is
 * counted in token_estimate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { compileContext, formatContextAsMarkdown } from '../src/context/compile.js';
import { DEFAULT_STAGES } from '../src/context/choreography.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

const PROJECT_ID = 'test-project';
const DUMMY_EMBEDDING = new Uint8Array(1536);

const CHOREO = {
  enabled: true,
  reviewTag: 'codex-review',
  stages: [...DEFAULT_STAGES],
  reviewPressureDays: 90,
};

describe('Choreography in compileContext', () => {
  let testDir: string;
  let db: Database;
  let docsPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-choreo-compile-'));
    docsPath = join(testDir, 'docs');
    await mkdir(docsPath, { recursive: true });
    db = createDatabase(join(testDir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)", [PROJECT_ID, testDir, new Date().toISOString()]);
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('populates process_guidance when a nudge precondition holds', async () => {
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Tried cookie sessions for auth, rejected', tags: ['rejected', 'auth'], embedding: DUMMY_EMBEDDING });
    const ctx = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID, choreography: CHOREO });
    expect(ctx.sections.process_guidance).toBeDefined();
    expect(ctx.sections.process_guidance!.some((n) => n.stage === 'rejection')).toBe(true);
  });

  it('omits process_guidance when no precondition holds', async () => {
    const ctx = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID, choreography: CHOREO });
    expect(ctx.sections.process_guidance).toBeUndefined();
  });

  it('does not run choreography when option is absent', async () => {
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Tried cookie sessions for auth, rejected', tags: ['rejected', 'auth'], embedding: DUMMY_EMBEDDING });
    const ctx = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID });
    expect(ctx.sections.process_guidance).toBeUndefined();
  });

  it('renders a terse markdown Process section when nudges exist', async () => {
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Tried cookie sessions for auth, rejected', tags: ['rejected', 'auth'], embedding: DUMMY_EMBEDDING });
    const ctx = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID, choreography: CHOREO });
    const md = formatContextAsMarkdown(ctx);
    expect(md).toContain('## Process');
    expect(md).toContain('rejection');
  });

  it('omits the markdown Process section when there are no nudges', async () => {
    const ctx = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID, choreography: CHOREO });
    const md = formatContextAsMarkdown(ctx);
    expect(md).not.toContain('## Process');
  });

  it('counts process_guidance in the token estimate', async () => {
    const empty = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID, choreography: CHOREO });
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Tried cookie sessions for auth, rejected because of CSRF exposure and refresh complexity', tags: ['rejected', 'auth'], embedding: DUMMY_EMBEDDING });
    const withNudge = await compileContext(db, { epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID, choreography: CHOREO });
    expect(withNudge.token_estimate).toBeGreaterThan(empty.token_estimate);
  });
});

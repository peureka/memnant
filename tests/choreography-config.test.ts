/**
 * Story S3 — config toggle + review_tag resolution.
 *
 * context.choreography is a master switch (default ON-but-quiet).
 * review_tag and stages are config-declared with sensible defaults.
 * Disabled => zero nudges. Custom review_tag drives the review gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { compileContext } from '../src/context/compile.js';
import { resolveChoreographyOptions, DEFAULT_STAGES, DEFAULT_REVIEW_TAG } from '../src/context/choreography.js';
import { createDefaultConfig } from '../src/config/defaults.js';
import type { ProjectConfig } from '../src/types.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});

const PROJECT_ID = 'test-project';
const DUMMY = new Uint8Array(1536);

describe('Choreography config resolution', () => {
  it('defaults to ON-but-quiet with default tag and stages', () => {
    const config = createDefaultConfig('demo', PROJECT_ID);
    const resolved = resolveChoreographyOptions(config);
    expect(resolved.enabled).toBe(true);
    expect(resolved.reviewTag).toBe(DEFAULT_REVIEW_TAG);
    expect(resolved.stages).toEqual([...DEFAULT_STAGES]);
    expect(resolved.reviewPressureDays).toBe(90);
  });

  it('respects the master switch when set false', () => {
    const config = createDefaultConfig('demo', PROJECT_ID);
    (config as ProjectConfig).context = { choreography: false };
    expect(resolveChoreographyOptions(config).enabled).toBe(false);
  });

  it('respects a custom review_tag and stages', () => {
    const config = createDefaultConfig('demo', PROJECT_ID);
    (config as ProjectConfig).context = { review_tag: 'peer-review', stages: ['rejection'] };
    const resolved = resolveChoreographyOptions(config);
    expect(resolved.reviewTag).toBe('peer-review');
    expect(resolved.stages).toEqual(['rejection']);
  });

  it('reads reviewPressureDays from memory config', () => {
    const config = createDefaultConfig('demo', PROJECT_ID);
    config.memory.review_pressure_days = 30;
    expect(resolveChoreographyOptions(config).reviewPressureDays).toBe(30);
  });
});

describe('Choreography master switch end-to-end', () => {
  let testDir: string;
  let db: Database;
  let docsPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-choreo-cfg-'));
    docsPath = join(testDir, 'docs');
    await mkdir(docsPath, { recursive: true });
    db = createDatabase(join(testDir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)", [PROJECT_ID, testDir, new Date().toISOString()]);
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('disabled config yields no process_guidance even when preconditions hold', async () => {
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Tried cookie sessions for auth, rejected', tags: ['rejected', 'auth'], embedding: DUMMY });
    const config = createDefaultConfig('demo', PROJECT_ID);
    (config as ProjectConfig).context = { choreography: false };
    const ctx = await compileContext(db, {
      epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID,
      choreography: resolveChoreographyOptions(config),
    });
    expect(ctx.sections.process_guidance).toBeUndefined();
  });

  it('custom review_tag drives the review gate off that tag', async () => {
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Chose JWT for the auth epic', tags: ['auth'], embedding: DUMMY });
    insertRecord(db, { projectId: PROJECT_ID, type: 'spec_snapshot', contentText: 'Auth spec: JWT tokens for the auth epic', tags: ['spec_snapshot'], embedding: DUMMY });
    // A codex-review record must not satisfy a peer-review gate.
    insertRecord(db, { projectId: PROJECT_ID, type: 'decision', contentText: 'Reviewed via codex for auth', tags: ['auth', 'codex-review'], embedding: DUMMY });
    const config = createDefaultConfig('demo', PROJECT_ID);
    (config as ProjectConfig).context = { review_tag: 'peer-review' };
    const ctx = await compileContext(db, {
      epic: 'auth', docsPath, projectRoot: testDir, projectId: PROJECT_ID,
      choreography: resolveChoreographyOptions(config),
    });
    const gate = ctx.sections.process_guidance?.find((n) => n.stage === 'review_gate');
    expect(gate).toBeDefined();
    expect(gate!.message).toContain('peer-review');
  });
});

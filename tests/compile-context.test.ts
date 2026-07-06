/**
 * Unit tests for context compilation.
 *
 * Verifies:
 * - Empty ledger returns minimal context
 * - No snapshot means no staleness warnings
 * - Decisions section populated when decisions exist
 * - Token estimate is a reasonable number
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { compileContext, formatContextAsMarkdown } from '../src/context/compile.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return {
    ...actual,
    generateEmbedding: async (text: string) => mockGenerateEmbedding(text),
  };
});

const PROJECT_ID = 'test-project';
const DUMMY_EMBEDDING = new Uint8Array(1536);

describe('Context Compilation', () => {
  let testDir: string;
  let db: Database;
  let docsPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-compile-'));
    docsPath = join(testDir, 'docs');
    await mkdir(docsPath, { recursive: true });

    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test-project', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('empty ledger returns minimal context with reasonable token estimate', async () => {
    const ctx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    expect(ctx).toHaveProperty('token_estimate');
    expect(ctx).toHaveProperty('warnings');
    expect(ctx).toHaveProperty('sections');
    expect(ctx.sections.last_session).toBeNull();
    expect(ctx.sections.open_todos).toEqual([]);
    expect(ctx.sections.epic_context).toBeNull();
    expect(ctx.sections.framework_fixes).toEqual([]);
    expect(ctx.sections.stale_decisions).toEqual([]);
    expect(typeof ctx.token_estimate).toBe('number');
    expect(ctx.token_estimate).toBeGreaterThan(0);
    expect(ctx.token_estimate).toBeLessThan(500);
  });

  it('no snapshot means no staleness warnings', async () => {
    // Insert a decision that mentions a file path
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'We use src/auth.ts for all authentication logic',
      embedding: DUMMY_EMBEDDING,
    });

    const ctx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    // No snapshot taken, so no staleness detected
    expect(ctx.sections.stale_decisions).toEqual([]);
  });

  it('decisions section populated when decisions exist', async () => {
    // Insert decisions tagged with an epic
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Chose PostgreSQL for auth module database',
      tags: ['auth'],
      embedding: DUMMY_EMBEDDING,
    });

    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'JWT tokens for auth session management',
      tags: ['auth'],
      embedding: DUMMY_EMBEDDING,
    });

    const ctx = await compileContext(db, {
      epic: 'auth',
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    expect(ctx.sections.epic_context).not.toBeNull();
    expect(ctx.sections.epic_context).toContain('PostgreSQL');
    expect(ctx.sections.epic_context).toContain('JWT');
  });

  it('framework fixes section populated when fixes exist', async () => {
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'framework_fix',
      contentText: 'Next.js 15: useSearchParams needs Suspense boundary',
      tags: ['nextjs'],
      embedding: DUMMY_EMBEDDING,
    });

    const ctx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    expect(ctx.sections.framework_fixes.length).toBe(1);
    expect(ctx.sections.framework_fixes[0]).toContain('useSearchParams');
  });

  it('token estimate scales with content', async () => {
    const emptyCtx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    // Add several records
    for (let i = 0; i < 10; i++) {
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'decision',
        contentText: `Decision number ${i}: We chose approach ${i} because of reason ${i} which affects the architecture significantly`,
        tags: ['arch'],
        embedding: DUMMY_EMBEDDING,
      });
    }

    const fullCtx = await compileContext(db, {
      epic: 'arch',
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    expect(fullCtx.token_estimate).toBeGreaterThan(emptyCtx.token_estimate);
  });

  it('formatContextAsMarkdown produces valid markdown', async () => {
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use TypeScript for all modules',
      tags: ['stack'],
      embedding: DUMMY_EMBEDDING,
    });

    const ctx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    const md = formatContextAsMarkdown(ctx);
    expect(md).toContain('## Last Session Summary');
    expect(md).toContain('## Open TODOs');
    expect(md).toContain('## Framework Fixes');
    expect(md).toContain('## Spec Constraints');
    expect(md).toContain('## Persona Tests');
    expect(md).toContain('Compiled context:');
  });

  it('spec constraints populated from docs with frontmatter', async () => {
    await writeFile(join(docsPath, 'design-system.md'), `---
type: design_system
applies_to: all
---

# Design System

Use only Tailwind for styling. No CSS-in-JS.
`);

    const ctx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    expect(ctx.sections.spec_constraints.length).toBe(1);
    expect(ctx.sections.spec_constraints[0]).toContain('design-system.md');
  });

  it('persona tests populated from persona docs', async () => {
    await writeFile(join(docsPath, 'kai.md'), `---
type: persona
applies_to: all
---

# Kai — Solo Builder

Would Kai actually use this feature daily?
Would this survive a 2am production incident?
`);

    const ctx = await compileContext(db, {
      docsPath,
      projectRoot: testDir,
      projectId: PROJECT_ID,
    });

    expect(ctx.sections.persona_tests.length).toBe(1);
    expect(ctx.sections.persona_tests[0]).toContain('kai.md');
  });
});

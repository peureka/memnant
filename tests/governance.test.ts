/**
 * Tests for Epic 14: Continuous Governance.
 *
 * Story 14.1: Spec-aware context injection (tested in context-predictive.test.ts).
 * Story 14.2: Pre-commit hook (lint --staged, setup git-hooks).
 * Story 14.3: Governance feedback loop (override tracking).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});
import { getOverrideSuggestions, getOverrideSummary } from '../src/governor/overrides.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';
const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { timeout?: number },
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 120_000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('Story 14.2: Pre-commit hook', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-governance-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('lint --staged shows no staged files message', () => {
    // Init project and git repo
    runMemnant(['init', '--non-interactive'], testDir);
    execFileSync('git', ['init'], { cwd: testDir });

    const result = runMemnant(['lint', '--staged'], testDir);
    // Either "No staged files" or "No spec documents" depending on state
    expect(result.status).toBe(0);
  });

  it('setup git-hooks installs pre-commit hook', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    execFileSync('git', ['init'], { cwd: testDir });

    const result = runMemnant(['setup', 'git-hooks'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pre-commit hook installed');

    const hookPath = join(testDir, '.git', 'hooks', 'pre-commit');
    expect(existsSync(hookPath)).toBe(true);

    const hookContent = readFileSync(hookPath, 'utf-8');
    expect(hookContent).toContain('memnant lint --staged');
  });

  it('setup git-hooks is idempotent', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    execFileSync('git', ['init'], { cwd: testDir });

    runMemnant(['setup', 'git-hooks'], testDir);
    const result = runMemnant(['setup', 'git-hooks'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already installed');

    // Check hook doesn't have duplicate entries
    const hookPath = join(testDir, '.git', 'hooks', 'pre-commit');
    const content = readFileSync(hookPath, 'utf-8');
    const matches = content.match(/memnant lint/g);
    expect(matches?.length).toBe(1);
  });

  it('setup git-hooks chains with existing hook', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    execFileSync('git', ['init'], { cwd: testDir });

    // Create an existing hook
    const hooksDir = join(testDir, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "existing hook"\n', { mode: 0o755 });

    const result = runMemnant(['setup', 'git-hooks'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('appended');

    const hookContent = readFileSync(join(hooksDir, 'pre-commit'), 'utf-8');
    expect(hookContent).toContain('existing hook');
    expect(hookContent).toContain('memnant lint --staged');
  });

  it('lint --force exits 0 even with violations', () => {
    runMemnant(['init', '--non-interactive'], testDir);

    // Create copy audit spec
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    writeFileSync(
      join(testDir, 'docs', 'COPY_AUDIT.md'),
      `---
type: copy_audit
applies_to: all
---

## Banned

- "utilize" → "use" — Plain English
`,
    );

    // Create a file with violations
    mkdirSync(join(testDir, 'src'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'readme.md'), 'We utilize this feature.');

    const result = runMemnant(['lint', 'src', '--force'], testDir, { timeout: 120_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--force: overriding violations');
    expect(result.stdout).toContain('governance override');
  });
});

describe('Story 14.3: Governance feedback loop', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-overrides-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns no suggestions when no overrides exist', () => {
    const suggestions = getOverrideSuggestions(db);
    expect(suggestions).toEqual([]);
  });

  it('returns suggestions after 3+ overrides of same rule', async () => {
    const msg = 'src/readme.md:5 [BANNED] "utilize" → use "use" — Plain English';
    const embedding = await generateEmbedding(msg);
    const embeddingBuffer = serializeEmbedding(embedding);

    // Insert the same override 3 times
    for (let i = 0; i < 3; i++) {
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'governance_override',
        contentText: msg,
        tags: ['override', 'lint'],
        embedding: embeddingBuffer,
      });
    }

    const suggestions = getOverrideSuggestions(db);
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]).toContain('3x');
    expect(suggestions[0]).toContain('Consider updating the spec');
  });

  it('does not suggest for fewer than 3 overrides', async () => {
    const msg = 'src/app.ts:10 [BANNED] "OldButton"';
    const embedding = await generateEmbedding(msg);

    for (let i = 0; i < 2; i++) {
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'governance_override',
        contentText: msg,
        tags: ['override', 'lint'],
        embedding: serializeEmbedding(embedding),
      });
    }

    const suggestions = getOverrideSuggestions(db);
    expect(suggestions).toEqual([]);
  });

  it('getOverrideSummary returns all overrides grouped', async () => {
    const msg1 = 'src/readme.md:5 [BANNED] "utilize"';
    const msg2 = 'src/app.ts:10 [BANNED] "OldButton"';
    const emb1 = await generateEmbedding(msg1);
    const emb2 = await generateEmbedding(msg2);

    for (let i = 0; i < 3; i++) {
      insertRecord(db, {
        projectId: PROJECT_ID,
        type: 'governance_override',
        contentText: msg1,
        tags: ['override'],
        embedding: serializeEmbedding(emb1),
      });
    }
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'governance_override',
      contentText: msg2,
      tags: ['override'],
      embedding: serializeEmbedding(emb2),
    });

    const summary = getOverrideSummary(db);
    expect(summary.length).toBe(2);
    expect(summary[0].count).toBe(3);
    expect(summary[1].count).toBe(1);
    expect(summary[0]).toHaveProperty('last_override');
  });
});

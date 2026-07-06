/**
 * Tests for NotebookLM ingest — parse exported markdown into records.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return {
    ...actual,
    generateEmbedding: async (text: string) => mockGenerateEmbedding(text),
  };
});

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { timeout?: number },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: opts?.timeout ?? 120_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('NotebookLM Ingest', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-ingest-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('parseNotebookLM', () => {
    it('parses sections grouped by type with date headers', async () => {
      const { parseNotebookLM } = await import('../src/cli/ingest.js');

      const markdown = `# my-app — Project Knowledge Ledger

Exported from memnant on 2026-03-01. 2 records.

---

## Decisions (1)

### 2026-02-14 — a3f2beef [auth, jwt]

We chose JWT over sessions because stateless is simpler for our API.

---

## Framework Fixes (1)

### 2026-02-15 — b7e1cafe [nextjs]

Next.js 15: useSearchParams needs Suspense boundary in app router.

---
`;

      const records = parseNotebookLM(markdown);
      expect(records).toHaveLength(2);

      expect(records[0].type).toBe('decision');
      expect(records[0].content_text).toContain('JWT over sessions');
      expect(records[0].tags).toContain('auth');
      expect(records[0].tags).toContain('jwt');

      expect(records[1].type).toBe('framework_fix');
      expect(records[1].content_text).toContain('useSearchParams');
      expect(records[1].tags).toContain('nextjs');
    });

    it('defaults to decision type for unknown sections', async () => {
      const { parseNotebookLM } = await import('../src/cli/ingest.js');

      const markdown = `# test — Ledger

---

## Custom Section (1)

### 2026-01-01 — abcd1234

Some content here.

---
`;

      const records = parseNotebookLM(markdown);
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('decision');
    });

    it('returns empty array for empty content', async () => {
      const { parseNotebookLM } = await import('../src/cli/ingest.js');
      const records = parseNotebookLM('');
      expect(records).toEqual([]);
    });
  });

  describe('CLI registration', () => {
    it('ingest command is registered in CLI index', () => {
      const indexCode = readFileSync('src/cli/index.ts', 'utf-8');
      expect(indexCode).toContain('registerIngestCommand');
    });
  });

  describe('CLI ingest', { timeout: 120_000 }, () => {
    let projectDir: string;

    beforeEach(async () => {
      projectDir = await mkdtemp(join(tmpdir(), 'memnant-ingest-cli-'));
      runMemnant(['init'], projectDir);
    });

    afterEach(async () => {
      await rm(projectDir, { recursive: true, force: true });
    });

    it('exits with error when file not found', () => {
      const result = runMemnant(['ingest', 'nonexistent.md'], projectDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('File not found');
    });

    it('--dry-run shows records without writing', async () => {
      const mdPath = join(projectDir, 'export.md');
      await writeFile(mdPath, `# test — Project Knowledge Ledger

Exported from memnant on 2026-03-01. 1 records.

---

## Decisions (1)

### 2026-02-14 — a3f2beef [auth]

We chose JWT for stateless auth.

---
`);

      const result = runMemnant(['ingest', mdPath, '--dry-run'], projectDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[decision]');
      expect(result.stdout).toContain('would be imported');
    });

    it('dedup: importing same file twice skips duplicates', async () => {
      const mdPath = join(projectDir, 'export.md');
      await writeFile(mdPath, `# test — Ledger

---

## Decisions (1)

### 2026-02-14 — a3f2beef [auth]

We chose JWT for stateless auth.

---
`);

      const first = runMemnant(['ingest', mdPath], projectDir);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('Imported 1 records');

      const second = runMemnant(['ingest', mdPath], projectDir);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('Imported 0 records');
      expect(second.stdout).toContain('1 skipped as duplicates');
    });

    it('malformed markdown returns 0 records', async () => {
      const mdPath = join(projectDir, 'bad.md');
      await writeFile(mdPath, 'This is just plain text with no structure at all.');

      const result = runMemnant(['ingest', mdPath], projectDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No records found');
    });
  });
});

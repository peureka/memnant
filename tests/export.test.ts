/**
 * Tests for Story 1.5: Export
 *
 * Integration tests that seed records via `memnant log` (full round-trip)
 * then verify `memnant export` behaviour against all acceptance criteria.
 * See docs/PLAN.md, Story 1.5 for the full AC.
 *
 * Timeout is extended to handle embedding model load.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { input?: string; timeout?: number },
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 120_000,
      input: opts?.input,
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

describe('memnant export', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-export-'));
    runMemnant(['init'], testDir);

    // Seed records for tests
    runMemnant(
      [
        'log',
        '--type',
        'decision',
        '--content',
        'We chose snapshot-first analytics because live aggregation adds 200ms',
        '--tags',
        'analytics,performance',
      ],
      testDir,
    );
    runMemnant(
      [
        'log',
        '--type',
        'framework_fix',
        '--content',
        'Next.js caching fix: set revalidate to 60 seconds for the dashboard API route',
        '--tags',
        'nextjs,caching',
      ],
      testDir,
    );
    runMemnant(
      [
        'log',
        '--type',
        'session_log',
        '--content',
        'Shipped auth flow. Decided on JWT over sessions for stateless scaling.',
      ],
      testDir,
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: memnant export creates type subdirectories with markdown files
  it('creates type subdirectories with markdown files', async () => {
    const result = runMemnant(['export'], testDir);
    expect(result.status).toBe(0);

    const exportDir = join(testDir, '.memnant', 'export');

    // Check type subdirectories exist
    const decisions = await readdir(join(exportDir, 'decisions'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatch(/\.md$/);

    const frameworkFixes = await readdir(join(exportDir, 'framework_fixes'));
    expect(frameworkFixes).toHaveLength(1);

    const sessionLogs = await readdir(join(exportDir, 'session_logs'));
    expect(sessionLogs).toHaveLength(1);

    // Empty type directories should exist too
    const specSnapshots = await readdir(join(exportDir, 'spec_snapshots'));
    expect(specSnapshots).toHaveLength(0);
  });

  // AC 2: Files are named {date}_{short-id}.md
  it('files are named {date}_{short-id}.md', async () => {
    runMemnant(['export'], testDir);

    const exportDir = join(testDir, '.memnant', 'export');
    const decisions = await readdir(join(exportDir, 'decisions'));

    // Pattern: YYYY-MM-DD_xxxx.md (4-char short id)
    expect(decisions[0]).toMatch(/^\d{4}-\d{2}-\d{2}_[0-9a-f]{4}\.md$/);
  });

  // AC 3: Files contain YAML frontmatter and content body
  it('files contain YAML frontmatter and content body', async () => {
    runMemnant(['export'], testDir);

    const exportDir = join(testDir, '.memnant', 'export');
    const decisions = await readdir(join(exportDir, 'decisions'));
    const content = await readFile(join(exportDir, 'decisions', decisions[0]), 'utf-8');

    // Check frontmatter structure
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('id:');
    expect(content).toContain('type: decision');
    expect(content).toContain('created_at:');
    expect(content).toContain('tags:');
    expect(content).toContain('related_records:');
    expect(content).toMatch(/---\n\n/); // Closing frontmatter + blank line

    // Check content body
    expect(content).toContain('snapshot-first analytics');
  });

  // AC 4: --format json exports a single JSON file
  it('--format json exports a single JSON file with all records', async () => {
    const result = runMemnant(['export', '--format', 'json'], testDir);
    expect(result.status).toBe(0);

    const jsonPath = join(testDir, '.memnant', 'export', 'export.json');
    const raw = await readFile(jsonPath, 'utf-8');
    const data = JSON.parse(raw);

    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(3);

    const first = data[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('type');
    expect(first).toHaveProperty('content_text');
    expect(first).toHaveProperty('tags');
    expect(first).toHaveProperty('related_records');
    expect(first).toHaveProperty('created_at');
  });

  // AC 5: --since filters by date
  it('--since filters records by date', () => {
    // Future date: no records
    const futureResult = runMemnant(['export', '--since', '2099-01-01'], testDir);
    expect(futureResult.status).toBe(0);
    expect(futureResult.stdout).toContain('Exported 0 records');

    // Today: includes records
    const today = new Date().toISOString().slice(0, 10);
    const todayResult = runMemnant(['export', '--since', today], testDir);
    expect(todayResult.status).toBe(0);
    expect(todayResult.stdout).toContain('Exported 3 records');
  });

  // AC 6: Export overwrites previous files (no duplicates)
  it('export overwrites previous files (no duplicates)', async () => {
    runMemnant(['export'], testDir);
    runMemnant(['export'], testDir);

    const exportDir = join(testDir, '.memnant', 'export');
    const decisions = await readdir(join(exportDir, 'decisions'));
    expect(decisions).toHaveLength(1); // Not 2
  });

  // AC 7: Prints "Exported {n} records to {path}"
  it('prints "Exported {n} records to {path}"', () => {
    const result = runMemnant(['export'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^Exported 3 records to \.memnant\/export\/$/);
  });

  // Error: No project → helpful error
  it('fails with helpful error when project is not initialised', async () => {
    const uninitDir = await mkdtemp(join(tmpdir(), 'memnant-export-noinit-'));

    const result = runMemnant(['export'], uninitDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No memnant project found');
    expect(result.stderr).toContain('memnant init');

    await rm(uninitDir, { recursive: true, force: true });
  });

  // Edge case: Empty ledger → exports 0 records gracefully
  it('handles empty ledger gracefully', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-export-empty-'));
    runMemnant(['init'], emptyDir);

    const result = runMemnant(['export'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Exported 0 records');

    await rm(emptyDir, { recursive: true, force: true });
  });
});

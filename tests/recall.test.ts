/**
 * Tests for Story 1.3: Recall Records
 *
 * Integration tests that seed records via `memnant log` (full round-trip)
 * then verify `memnant recall` behaviour against all acceptance criteria.
 * See docs/PLAN.md, Story 1.3 for the full AC.
 *
 * Timeout is extended to handle embedding model load.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
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

describe('memnant recall', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-recall-'));
    runMemnant(['init'], testDir);

    // Seed records for tests
    runMemnant(
      [
        'log',
        '--type',
        'decision',
        '--content',
        'We chose snapshot-first analytics because live aggregation adds 200ms to every page load',
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
        'decision',
        '--content',
        'Authentication uses JWT stored in httpOnly cookies rather than localStorage for XSS protection',
      ],
      testDir,
    );
    const longContent =
      'Detailed analysis of the performance bottleneck in the rendering pipeline. ' +
      'The issue was traced to unnecessary re-renders caused by context propagation in the ' +
      'component tree. We fixed it by memoizing the context value object and splitting the ' +
      'global context into domain-specific contexts. This reduced re-renders by 80% and ' +
      'improved Time to Interactive by 1.2 seconds on mobile devices. ' +
      'Additional notes: the profiler showed that the heaviest components were the data grid ' +
      'and the chart widgets which were subscribing to the root context unnecessarily.';
    runMemnant(
      ['log', '--type', 'session_log', '--content', longContent],
      testDir,
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: Semantic query returns ranked results
  it('returns ranked results for a semantic query', () => {
    const result = runMemnant(['recall', 'analytics and page load performance'], testDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('snapshot-first analytics');
  });

  // AC 2: Output format has short ID, type, date, score, content
  it('output has short ID, type, date, score, and content', () => {
    const result = runMemnant(['recall', 'analytics'], testDir);
    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);

    // Each line: {8-char-id}  {type}  {YYYY-MM-DD}  {score}  {content}
    const firstLine = lines[0];
    const match = firstLine.match(
      /^([0-9a-f]{8})\s{2}(\w+)\s{2}(\d{4}-\d{2}-\d{2})\s{2}(\d+\.\d{3})\s{2}(.+)/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toHaveLength(8); // short ID
    expect(match![3]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // date
    const score = parseFloat(match![4]);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  // AC 3: --type filters results
  it('--type filters results to specified type only', () => {
    const result = runMemnant(
      ['recall', 'authentication cookies JWT', '--type', 'decision'],
      testDir,
    );
    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      expect(line).toMatch(/decision/);
    }
    // Should not contain framework_fix or session_log results
    expect(result.stdout).not.toContain('framework_fix');
    expect(result.stdout).not.toContain('session_log');
  });

  // AC 3b: --type rejects invalid types with helpful error
  it('rejects invalid --type with helpful error', () => {
    const result = runMemnant(['recall', 'test', '--type', 'note'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown record type 'note'");
    expect(result.stderr).toContain('Valid types:');
  });

  // AC 4: --since with future date returns no results
  it('--since with future date returns no results', () => {
    const result = runMemnant(['recall', 'analytics', '--since', '2099-01-01'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No relevant records found.');
  });

  // AC 4b: --since with today includes records
  it('--since with today includes records', () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = runMemnant(['recall', 'analytics', '--since', today], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('No relevant records found.');
  });

  // AC 4c: --since rejects invalid format
  it('rejects invalid --since format', () => {
    const result = runMemnant(['recall', 'test', '--since', 'January'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid date format 'January'");
    expect(result.stderr).toContain('YYYY-MM-DD');
  });

  // AC 5: --limit caps result count
  it('--limit caps result count', () => {
    const result = runMemnant(['recall', 'performance caching rendering', '--limit', '1'], testDir);
    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  // AC 6: --full shows complete content (no truncation)
  it('--full shows complete content without truncation', () => {
    const result = runMemnant(['recall', 'rendering pipeline performance bottleneck', '--full'], testDir);
    expect(result.status).toBe(0);

    // The session_log content is >200 chars, --full should show it all
    // Find the line with the long content
    const lines = result.stdout.trim().split('\n');
    const longLine = lines.find((l) => l.includes('rendering pipeline'));
    expect(longLine).toBeDefined();
    expect(longLine).toContain('subscribing to the root context unnecessarily');
    expect(longLine).not.toContain('...');
  });

  // AC 6b: Default output truncates long content
  it('truncates long content by default', () => {
    const result = runMemnant(['recall', 'rendering pipeline performance bottleneck'], testDir);
    expect(result.status).toBe(0);

    const lines = result.stdout.trim().split('\n');
    const longLine = lines.find((l) => l.includes('rendering pipeline'));
    expect(longLine).toBeDefined();
    expect(longLine).toContain('...');
  });

  // AC 7: --json outputs valid JSON array with expected fields
  it('--json outputs valid JSON array with expected fields', () => {
    const result = runMemnant(['recall', 'analytics', '--json'], testDir);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const first = parsed[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('short_id');
    expect(first).toHaveProperty('type');
    expect(first).toHaveProperty('created_at');
    expect(first).toHaveProperty('content');
    expect(first).toHaveProperty('similarity');
    expect(first).toHaveProperty('tags');
    expect(first).toHaveProperty('related_records');

    expect(first.short_id).toHaveLength(8);
    expect(typeof first.similarity).toBe('number');
    expect(Array.isArray(first.tags)).toBe(true);
  });

  // AC 8: No matches returns "No relevant records found."
  it('prints "No relevant records found." for nonsense queries', () => {
    const result = runMemnant(['recall', 'xyzzy nonsense gibberish qqq'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('No relevant records found.');
  });

  // AC 9: Empty ledger handled gracefully
  it('handles empty ledger gracefully', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-empty-'));
    runMemnant(['init'], emptyDir);

    const result = runMemnant(['recall', 'anything'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('No relevant records found.');

    await rm(emptyDir, { recursive: true, force: true });
  });

  // AC 10: Recall without init fails with helpful error
  it('fails with helpful error when project is not initialised', async () => {
    const uninitDir = await mkdtemp(join(tmpdir(), 'memnant-noinit-'));

    const result = runMemnant(['recall', 'anything'], uninitDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No memnant project found');
    expect(result.stderr).toContain('memnant init');

    await rm(uninitDir, { recursive: true, force: true });
  });
});

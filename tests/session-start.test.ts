/**
 * Tests for Story 2.1: Session Start with Context Compilation
 *
 * Integration tests that verify `memnant session start` creates sessions
 * and outputs compiled context. Follows the same pattern as recall.test.ts.
 *
 * See docs/PLAN.md, Story 2.1 for the full AC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import type { ProjectConfig } from '../src/types.js';

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

function openDb(testDir: string): Database {
  const config = yaml.load(readFileSync(join(testDir, 'memnant.yaml'), 'utf-8')) as ProjectConfig;
  return new Database(join(testDir, config.memory.db_path));
}

describe('memnant session start', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-session-start-'));
    runMemnant(['init'], testDir);

    // Seed some records for context compilation
    runMemnant(
      ['log', '--type', 'decision', '--content', 'We chose JWT for auth because of XSS protection', '--tags', 'auth,epic-1'],
      testDir,
    );
    runMemnant(
      ['log', '--type', 'framework_fix', '--content', 'Next.js caching fix: set revalidate to 60s for dashboard API route', '--tags', 'nextjs'],
      testDir,
    );
    runMemnant(
      ['log', '--type', 'decision', '--content', 'Analytics v2 will use snapshot-first approach to avoid 200ms penalty', '--tags', 'Analytics v2'],
      testDir,
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: session start creates a Session row and outputs compiled context
  it('creates a session row and outputs compiled context', () => {
    const result = runMemnant(['session', 'start'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Last Session Summary');
    expect(result.stdout).toContain('## Open TODOs');
    expect(result.stdout).toContain('## Framework Fixes');

    // Verify session was created in DB
    const db = openDb(testDir);
    const sessions = db.all('SELECT * FROM session WHERE closed_at IS NULL');
    expect(sessions.length).toBe(1);
    db.close();

    // Clean up: close the session so next tests can start fresh
    const db2 = openDb(testDir);
    db2.run("UPDATE session SET closed_at = datetime('now') WHERE closed_at IS NULL");
    db2.close();
  });

  // AC 2: Compiled context has section headers in correct order
  it('has section headers in correct order', () => {
    const result = runMemnant(['session', 'start'], testDir);
    expect(result.status).toBe(0);

    const headers = [
      '## Last Session Summary',
      '## Open TODOs',
      '## Framework Fixes',
      '## Spec Constraints',
      '## Persona Tests',
    ];
    let lastIndex = -1;
    for (const header of headers) {
      const idx = result.stdout.indexOf(header);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }

    // Clean up
    const db = openDb(testDir);
    db.run("UPDATE session SET closed_at = datetime('now') WHERE closed_at IS NULL");
    db.close();
  });

  // Choreography reaches the CLI path (default-on), not just MCP.
  it('surfaces the choreography process layer in CLI output', () => {
    runMemnant(
      ['log', '--type', 'decision', '--content', 'Tried Redis for sessions, rejected: ops overhead', '--tags', 'rejected,choreo-epic'],
      testDir,
    );
    const result = runMemnant(['session', 'start', '--dry-run', '--epic', 'choreo-epic'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Process');
    expect(result.stdout).toContain('do not re-propose');
  });

  // AC 3: --epic filters context to relevant records
  it('--epic filters context to relevant records', () => {
    const result = runMemnant(['session', 'start', '--epic', 'Analytics v2'], testDir);
    expect(result.status).toBe(0);

    expect(result.stdout).toContain('## Epic Context');
    expect(result.stdout).toContain('Analytics v2');
    expect(result.stdout).toContain('snapshot-first');

    // Clean up
    const db = openDb(testDir);
    db.run("UPDATE session SET closed_at = datetime('now') WHERE closed_at IS NULL");
    db.close();
  });

  // AC 4: --dry-run outputs context without creating a session
  it('--dry-run outputs context without creating a session', () => {
    const db = openDb(testDir);
    const before = (db.get('SELECT COUNT(*) as count FROM session') as unknown as { count: number }).count;
    db.close();

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Last Session Summary');

    const db2 = openDb(testDir);
    const after = (db2.get('SELECT COUNT(*) as count FROM session') as unknown as { count: number }).count;
    db2.close();

    expect(after).toBe(before);
  });

  // AC 5: Active session blocks start (with correct warning message)
  it('active session blocks start', () => {
    // Start a session first
    const startResult = runMemnant(['session', 'start'], testDir);
    expect(startResult.status).toBe(0);

    // Try to start another — should fail
    const result = runMemnant(['session', 'start'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is still open');
    expect(result.stderr).toContain('memnant session close');
    expect(result.stderr).toContain('--force');

    // Clean up
    const db = openDb(testDir);
    db.run("UPDATE session SET closed_at = datetime('now') WHERE closed_at IS NULL");
    db.close();
  });

  // AC 6: --force abandons active session and starts new one
  it('--force abandons active session and starts new one', () => {
    // Start a session
    runMemnant(['session', 'start'], testDir);

    // Force start a new one
    const result = runMemnant(['session', 'start', '--force'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('## Last Session Summary');

    // Verify old session was closed with log_skipped
    const db = openDb(testDir);
    const skipped = db.all(
      "SELECT * FROM session WHERE log_skipped = 'abandoned by --force'",
    );
    expect(skipped.length).toBeGreaterThanOrEqual(1);

    // Verify new session is active
    const active = db.all('SELECT * FROM session WHERE closed_at IS NULL');
    expect(active.length).toBe(1);

    db.run("UPDATE session SET closed_at = datetime('now') WHERE closed_at IS NULL");
    db.close();
  });

  // AC 7: Previous session with log_skipped shows warning in context
  it('previous session with log_skipped shows warning in context', () => {
    // The --force test above created a skipped session; start fresh context
    const result = runMemnant(['session', 'start'], testDir);
    expect(result.status).toBe(0);

    // Should contain the blind spots warning
    expect(result.stdout).toContain('has no log');
    expect(result.stdout).toContain('blind spots');

    // Clean up
    const db = openDb(testDir);
    db.run("UPDATE session SET closed_at = datetime('now') WHERE closed_at IS NULL");
    db.close();
  });

  // AC 8: Token estimate appears at top
  it('token estimate appears at top', () => {
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);

    const firstLine = result.stdout.split('\n')[0];
    expect(firstLine).toMatch(/Compiled context: ~\d+ tokens/);
  });

  // AC 9: No project → helpful error
  it('fails with helpful error when no project', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-noproject-'));
    const result = runMemnant(['session', 'start'], emptyDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No memnant project found');
    await rm(emptyDir, { recursive: true, force: true });
  });

  // AC 10: Empty ledger starts with minimal context gracefully
  it('starts gracefully with empty ledger', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-empty-'));
    runMemnant(['init'], emptyDir);

    const result = runMemnant(['session', 'start'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No previous session log available.');
    expect(result.stdout).toContain('No open TODOs.');
    expect(result.stdout).toContain('No framework fixes recorded.');

    await rm(emptyDir, { recursive: true, force: true });
  });
});

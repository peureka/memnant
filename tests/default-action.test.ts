/**
 * Tests for Story 6.1: Default Action Router
 *
 * Verifies that `memnant` with no subcommand routes correctly based on state:
 * 1. Uninitialised → triggers init
 * 2. Initialised, no session → starts session
 * 3. Active session → shows status
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, realpathSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { timeout?: number },
): { stdout: string; stderr: string; status: number } {
  try {
    const result = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: result, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('memnant default action (no subcommand)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-default-')));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('uninitialised dir → triggers init (non-interactive in test)', () => {
    const result = runMemnant([], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialised memnant project');
    expect(existsSync(join(testDir, 'memnant.yaml'))).toBe(true);
    expect(existsSync(join(testDir, '.memnant', 'ledger.db'))).toBe(true);
  });

  it('initialised, no session → starts session with context', () => {
    runMemnant(['init'], testDir);

    // Run with no args — should start a session and output context
    const result = runMemnant([], testDir);
    expect(result.status).toBe(0);
    // Context output goes to stdout
    expect(result.stdout).toContain('Compiled context:');
  });

  it('active session → shows status', () => {
    runMemnant(['init'], testDir);
    runMemnant([], testDir); // starts session

    // Run again — should show status
    const result = runMemnant([], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Session:');
    expect(result.stdout).toContain('Started:');
    expect(result.stdout).toContain('Duration:');
    expect(result.stdout).toContain('Records:');
  });

  it('existing subcommands still work', () => {
    runMemnant(['init'], testDir);
    const result = runMemnant(['status'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Project:');
  });
});

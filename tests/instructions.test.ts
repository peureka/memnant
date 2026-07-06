/**
 * Tests for memnant instructions command.
 *
 * Verifies output contains expected sections for each tool format.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
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

describe('memnant instructions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-instr-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('outputs generic instructions by default', () => {
    const result = runMemnant(['instructions'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# memnant');
    expect(result.stdout).toContain('recall');
    expect(result.stdout).toContain('log');
    expect(result.stdout).toContain('session_context');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('check_copy');
    expect(result.stdout).toContain('check_design');
    expect(result.stdout).toContain('Session Workflow');
  });

  it('outputs claude-code formatted instructions', () => {
    const result = runMemnant(['instructions', '--tool', 'claude-code'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# memnant');
    expect(result.stdout).toContain('MCP Tools');
    expect(result.stdout).toContain('recall');
    expect(result.stdout).toContain('Workflow');
  });

  it('outputs codex formatted instructions', () => {
    const result = runMemnant(['instructions', '--tool', 'codex'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# memnant');
    expect(result.stdout).toContain('MCP Tools');
    expect(result.stdout).toContain('recall');
  });

  it('includes project info when initialised', () => {
    runMemnant(['init'], testDir);
    const result = runMemnant(['instructions'], testDir);
    expect(result.stdout).toContain('.memnant/ledger.db');
    expect(result.stdout).not.toContain('not initialised');
  });

  it('shows not-initialised message when no project', () => {
    const result = runMemnant(['instructions'], testDir);
    expect(result.stdout).toContain('not initialised');
  });

  it('rejects unknown tool names', () => {
    const result = runMemnant(['instructions', '--tool', 'vim'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown tool 'vim'");
  });
});

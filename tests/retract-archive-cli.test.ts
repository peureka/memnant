/**
 * Tests for CLI commands: retract, unretract, archive, unarchive.
 *
 * Task 6: CLI wrappers around the admin functions.
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
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
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

describe('retract and archive CLI commands', () => {
  let testDir: string;
  let recordId: string;
  let archiveRecordId: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-cli-admin-'));
    runMemnant(['init'], testDir);

    // Create two records to work with
    const logResult = runMemnant(
      ['log', '--type', 'decision', '--content', 'We chose React for the frontend'],
      testDir,
    );
    const match = logResult.stdout.match(/([0-9a-f-]{36})/);
    recordId = match![1];

    const logResult2 = runMemnant(
      ['log', '--type', 'decision', '--content', 'We chose Postgres for the database'],
      testDir,
    );
    const match2 = logResult2.stdout.match(/([0-9a-f-]{36})/);
    archiveRecordId = match2![1];
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('retract', () => {
    it('retracts a record with a reason', () => {
      const result = runMemnant(
        ['retract', recordId, '--reason', 'Switched to Vue instead'],
        testDir,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Retracted');
      expect(result.stdout).toContain(recordId.slice(0, 8));
    });

    it('fails without --reason', () => {
      const result = runMemnant(['retract', recordId], testDir);
      expect(result.status).not.toBe(0);
    });

    it('fails with unknown record ID', () => {
      const result = runMemnant(
        ['retract', 'nonexistent-id', '--reason', 'test'],
        testDir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('unretract', () => {
    it('unretracts a previously retracted record', () => {
      const result = runMemnant(['unretract', recordId], testDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Unretracted');
      expect(result.stdout).toContain(recordId.slice(0, 8));
    });

    it('fails with unknown record ID', () => {
      const result = runMemnant(['unretract', 'nonexistent-id'], testDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('archive', () => {
    it('archives a single record by ID', () => {
      const result = runMemnant(
        ['archive', '--id', archiveRecordId],
        testDir,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Archived');
      expect(result.stdout).toContain(archiveRecordId.slice(0, 8));
    });

    it('fails without any flags', () => {
      const result = runMemnant(['archive'], testDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Specify at least one');
    });

    it('fails with unknown record ID', () => {
      const result = runMemnant(
        ['archive', '--id', 'nonexistent-id'],
        testDir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('--superseded runs without error', () => {
      const result = runMemnant(['archive', '--superseded'], testDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('superseded');
    });

    it('--stale-older-than runs without error', () => {
      const result = runMemnant(
        ['archive', '--stale-older-than', '90d'],
        testDir,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stale');
    });

    it('--stale-older-than rejects invalid format', () => {
      const result = runMemnant(
        ['archive', '--stale-older-than', 'abc'],
        testDir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid duration');
    });
  });

  describe('unarchive', () => {
    it('unarchives a single record by ID', () => {
      const result = runMemnant(
        ['unarchive', '--id', archiveRecordId],
        testDir,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Unarchived');
      expect(result.stdout).toContain(archiveRecordId.slice(0, 8));
    });

    it('--all unarchives all archived records', () => {
      // Archive first, then unarchive all
      runMemnant(['archive', '--id', archiveRecordId], testDir);
      const result = runMemnant(['unarchive', '--all'], testDir);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Unarchived');
    });

    it('fails without any flags', () => {
      const result = runMemnant(['unarchive'], testDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Specify at least one');
    });

    it('fails with unknown record ID', () => {
      const result = runMemnant(
        ['unarchive', '--id', 'nonexistent-id'],
        testDir,
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });
});

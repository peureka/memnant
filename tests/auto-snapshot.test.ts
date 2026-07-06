/**
 * Auto-snapshot on session start.
 *
 * Staleness detection is dead without a codebase snapshot, and the old
 * age-warning only fired when a snapshot already existed — a project that
 * never snapshotted was never told (found in real ledgers: 10 projects,
 * 0 snapshots, 0 staleness ever). Session start now takes one automatically
 * when none exists or the last one is older than the snapshot interval.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 1 };
}

function countSnapshots(testDir: string): number {
  const db = new Database(join(testDir, '.memnant', 'ledger.db'));
  try {
    const row = db.get(
      "SELECT COUNT(*) as count FROM record WHERE type = 'codebase_snapshot'",
    ) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function backdateSnapshots(testDir: string, days: number): void {
  const db = new Database(join(testDir, '.memnant', 'ledger.db'));
  try {
    const then = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE record SET created_at = ? WHERE type = 'codebase_snapshot'", [then]);
  } finally {
    db.close();
  }
}

describe('auto-snapshot on session start', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-autosnap-'));
    await writeFile(join(testDir, 'app.ts'), 'export const answer = 42;\n');
    runMemnant(['init'], testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('takes a snapshot when none exists', () => {
    expect(countSnapshots(testDir)).toBe(0);
    const result = runMemnant(['session', 'start'], testDir);
    expect(result.status).toBe(0);
    expect(countSnapshots(testDir)).toBe(1);
    runMemnant(['session', 'close', '--skip', 'test'], testDir);
  });

  it('does not duplicate a fresh snapshot', () => {
    runMemnant(['session', 'start'], testDir);
    runMemnant(['session', 'close', '--skip', 'test'], testDir);
    expect(countSnapshots(testDir)).toBe(1);
    runMemnant(['session', 'start'], testDir);
    runMemnant(['session', 'close', '--skip', 'test'], testDir);
    expect(countSnapshots(testDir)).toBe(1);
  });

  it('refreshes a snapshot older than the monthly interval', () => {
    runMemnant(['session', 'start'], testDir);
    runMemnant(['session', 'close', '--skip', 'test'], testDir);
    backdateSnapshots(testDir, 35);
    runMemnant(['session', 'start'], testDir);
    runMemnant(['session', 'close', '--skip', 'test'], testDir);
    expect(countSnapshots(testDir)).toBe(2);
  });

  it('end-to-end: a decision about a file that later changes is flagged stale', async () => {
    // Session 1 establishes the baseline snapshot and logs a decision.
    runMemnant(['session', 'start'], testDir);
    runMemnant(
      ['log', '--type', 'decision', '--content', 'app.ts exports the answer constant used across the app'],
      testDir,
    );
    runMemnant(['session', 'close', '--skip', 'test'], testDir);

    // The file the decision references changes after the snapshot.
    await writeFile(join(testDir, 'app.ts'), 'export const answer = 43; // changed\n');

    // Recall must now flag the decision as stale.
    const result = runMemnant(['recall', 'answer constant', '--explain'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('stale');
  });
});

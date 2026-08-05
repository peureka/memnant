/**
 * Tests for the stale temp-dir reaper (backlog 2026-08-05: crashed/timed-out
 * runs leak mkdtemp dirs because afterAll never runs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { reapStaleTmpDirs } from './reap-stale-tmp.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('reapStaleTmpDirs', () => {
  let root: string;

  /** Create an entry under root and set its mtime `ageMs` into the past. */
  function aged(name: string, ageMs: number, kind: 'dir' | 'file' = 'dir'): string {
    const p = join(root, name);
    if (kind === 'dir') {
      mkdirSync(p);
      writeFileSync(join(p, 'ledger.db'), 'x'); // non-empty, like a real leak
    } else {
      writeFileSync(p, 'x');
    }
    const past = new Date(Date.now() - ageMs);
    utimesSync(p, past, past);
    return p;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reap-fixture-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes prefix-matching dirs older than maxAge and keeps everything else', () => {
    const oldLeak = aged('memnant-export-session-abc123', 2 * DAY_MS);
    const freshRun = aged('memnant-test-home-def456', 0);
    const oldOtherPrefix = aged('vitest-xyz', 2 * DAY_MS);
    const oldFile = aged('memnant-stray.log', 2 * DAY_MS, 'file');

    const deleted = reapStaleTmpDirs(root, 'memnant-', DAY_MS);

    expect(existsSync(oldLeak)).toBe(false);
    expect(existsSync(freshRun)).toBe(true);
    expect(existsSync(oldOtherPrefix)).toBe(true);
    expect(existsSync(oldFile)).toBe(true);
    expect(deleted).toEqual([oldLeak]);
  });
});

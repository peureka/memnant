/**
 * Tests for Story 3.3: Snapshot Automation
 *
 * Integration tests for snapshot reminders at session start and
 * the --auto flag for git hook integration.
 *
 * See docs/PLAN.md, Story 3.3 for the full AC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
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
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: opts?.timeout ?? 120_000,
    input: opts?.input,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function openDb(testDir: string): Database {
  const config = yaml.load(readFileSync(join(testDir, 'memnant.yaml'), 'utf-8')) as ProjectConfig;
  return new Database(join(testDir, config.memory.db_path));
}

describe('snapshot automation', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-snapauto-'));
    await writeFile(join(testDir, 'index.ts'), 'export const main = () => {};\n');
    await writeFile(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: { express: '^4.18.0' },
    }, null, 2));
    runMemnant(['init'], testDir);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC (superseded): the >30-day reminder is now an automatic snapshot —
  // session start self-heals instead of asking the human to run a command.
  it('auto-refreshes the snapshot when the last one is > 30 days old', () => {
    // Take a snapshot, then backdate it
    runMemnant(['snapshot'], testDir);

    const db = openDb(testDir);
    // Set the snapshot's created_at to 35 days ago
    const daysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      "UPDATE record SET created_at = ? WHERE type = 'codebase_snapshot'", [daysAgo],
    );
    db.close();

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('taken automatically');
    expect(result.stdout).toContain('staleness tracking');
  });

  // AC: Reminder is a single line, does not block session start
  it('reminder does not block session start', () => {
    // Session start should succeed (not exit 1) even with old snapshot
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    // Should still have all the normal sections
    expect(result.stdout).toContain('Last Session Summary');
    expect(result.stdout).toContain('Open TODOs');
  });

  // AC: snapshot_interval milestone → no reminders
  it('no reminder when snapshot_interval is milestone', () => {
    // Change config to milestone
    const configPath = join(testDir, 'memnant.yaml');
    const config = yaml.load(readFileSync(configPath, 'utf-8')) as ProjectConfig;
    config.memory.snapshot_interval = 'milestone';
    const yamlStr = yaml.dump(config);
    require('fs').writeFileSync(configPath, yamlStr);

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('days old');
    expect(result.stdout).not.toContain('memnant snapshot');

    // Restore config
    config.memory.snapshot_interval = 'monthly';
    require('fs').writeFileSync(configPath, yaml.dump(config));
  });

  // AC: --auto only creates snapshot if previous is > 24 hours old
  it('--auto skips when snapshot is recent', () => {
    // Take a fresh snapshot
    runMemnant(['snapshot'], testDir);

    const db = openDb(testDir);
    const before = (db.get("SELECT COUNT(*) as count FROM record WHERE type = 'codebase_snapshot'") as unknown as { count: number }).count;
    db.close();

    // --auto should skip (snapshot is fresh)
    const result = runMemnant(['snapshot', '--auto'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping');

    const db2 = openDb(testDir);
    const after = (db2.get("SELECT COUNT(*) as count FROM record WHERE type = 'codebase_snapshot'") as unknown as { count: number }).count;
    db2.close();
    expect(after).toBe(before);
  });

  // AC: --auto creates snapshot if previous is > 24 hours old
  it('--auto creates snapshot when previous is > 24 hours old', () => {
    const db = openDb(testDir);
    // Backdate all snapshots to 25 hours ago
    const hoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.run(
      "UPDATE record SET created_at = ? WHERE type = 'codebase_snapshot'", [hoursAgo],
    );
    db.close();

    const result = runMemnant(['snapshot', '--auto'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('created');
  });

  // No reminder when snapshot is fresh (< 30 days)
  it('no reminder when snapshot is fresh', () => {
    // Take a fresh snapshot
    runMemnant(['snapshot'], testDir);

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('days old');
  });
});

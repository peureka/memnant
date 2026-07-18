/**
 * Tests for init on already-initialised projects — team mode reachability
 * and ledger repair for config-present/ledger-missing checkouts (e.g. a fresh
 * git worktree, where .memnant/ is gitignored and absent).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync, execFileSync } from 'child_process';
import yaml from 'js-yaml';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;
import type { ProjectConfig } from '../src/types.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf-8', timeout: 60_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

function readConfig(dir: string): ProjectConfig {
  return yaml.load(readFileSync(join(dir, 'memnant.yaml'), 'utf-8')) as ProjectConfig;
}

describe('memnant init — team mode + ledger repair on initialised projects', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-init-repair-'));
    execFileSync('git', ['init'], { cwd: testDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test Builder'], { cwd: testDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Test 1
  it('init --team on an already-initialised project sets builder + updates .gitignore, keeps project id', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    const before = readConfig(testDir);
    expect((before.project as any).builder).toBeUndefined();
    const originalId = before.project.id;

    const result = runMemnant(['init', '--non-interactive', '--team'], testDir);
    expect(result.status).toBe(0);

    const after = readConfig(testDir);
    expect((after.project as any).builder).toBe('Test Builder');
    expect(after.project.id).toBe(originalId);

    const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.memnant/ledger.db');
  });

  // Test 2
  it('init on config-present/ledger-missing recreates the ledger, preserves project id, leaves memnant.yaml untouched', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    const originalYaml = readFileSync(join(testDir, 'memnant.yaml'), 'utf-8');
    const originalId = readConfig(testDir).project.id;

    // Simulate a fresh worktree: memnant.yaml committed, .memnant/ gitignored & absent.
    rmSync(join(testDir, '.memnant'), { recursive: true, force: true });
    expect(existsSync(join(testDir, '.memnant', 'ledger.db'))).toBe(false);

    const result = runMemnant(['init', '--non-interactive'], testDir);
    expect(result.status).toBe(0);

    const dbPath = join(testDir, '.memnant', 'ledger.db');
    expect(existsSync(dbPath)).toBe(true);

    const db = new Database(dbPath);
    const project = db.get('SELECT id FROM project') as unknown as { id: string };
    db.close();
    expect(project.id).toBe(originalId);

    // memnant.yaml must be byte-identical (no id regeneration, no rewrite).
    expect(readFileSync(join(testDir, 'memnant.yaml'), 'utf-8')).toBe(originalYaml);
  });

  // Test 3
  it('init --team on config-present/ledger-missing repairs the ledger AND configures team mode', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    const originalId = readConfig(testDir).project.id;

    rmSync(join(testDir, '.memnant'), { recursive: true, force: true });

    const result = runMemnant(['init', '--non-interactive', '--team'], testDir);
    expect(result.status).toBe(0);

    // Ledger repaired with the same project id.
    const dbPath = join(testDir, '.memnant', 'ledger.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const project = db.get('SELECT id FROM project') as unknown as { id: string };
    db.close();
    expect(project.id).toBe(originalId);

    // Team mode configured.
    const after = readConfig(testDir);
    expect((after.project as any).builder).toBe('Test Builder');
    expect(after.project.id).toBe(originalId);
    const gitignore = readFileSync(join(testDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.memnant/ledger.db');
  });

  // Test 4 (regression)
  it('fully-initialised project with no flags still prints "already initialised" and changes nothing', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    const originalYaml = readFileSync(join(testDir, 'memnant.yaml'), 'utf-8');

    const result = runMemnant(['init', '--non-interactive'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already initialised');
    expect(readFileSync(join(testDir, 'memnant.yaml'), 'utf-8')).toBe(originalYaml);
  });
});

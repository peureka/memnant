/**
 * Tests for Story 3.2: Staleness Detection at Session Start
 *
 * Integration tests that verify stale decision and framework fix records
 * are flagged in compiled context and recall results.
 *
 * See docs/PLAN.md, Story 3.2 for the full AC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
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

describe('staleness detection', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-staleness-'));

    // Create project files
    await writeFile(join(testDir, 'index.ts'), 'export const main = () => {};\n');
    await mkdir(join(testDir, 'src'), { recursive: true });
    await writeFile(join(testDir, 'src', 'auth.ts'), 'export function login() {}\n');
    await writeFile(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: { express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2));

    // Init memnant and take a baseline snapshot
    runMemnant(['init'], testDir);
    runMemnant(['snapshot'], testDir);

    // Log a decision that mentions src/auth.ts
    runMemnant([
      'log', '--type', 'decision',
      '--content', 'Use JWT tokens for authentication in src/auth.ts. Passport.js was rejected.',
    ], testDir);

    // Log a framework fix that mentions express
    runMemnant([
      'log', '--type', 'framework_fix',
      '--content', 'express body-parser middleware must be registered before routes. Without it, req.body is undefined.',
    ], testDir);

    // Now modify files to create drift — content must be semantically related
    // to the decision ("JWT tokens for authentication") so semantic staleness triggers.
    // Switching to session-based auth creates real semantic overlap.
    await writeFile(join(testDir, 'src', 'auth.ts'), 'export function login() { /* switched from JWT to session-based cookie authentication */ }\nexport function logout() { clearSessionCookie(); }\n');
    await writeFile(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: { express: '^5.0.0' },  // express version changed
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC: Decision records whose content_text mentions changed file paths get a staleness warning
  it('session start shows stale decisions for changed files', () => {
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Potentially Stale Decisions');
    expect(result.stdout).toContain('src/auth.ts');
  });

  // AC: Framework fix records are checked for staleness against dependency changes
  it('session start shows stale framework fixes for changed dependencies', () => {
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    // The framework fix mentions "express" and express version changed
    expect(result.stdout).toContain('express');
    expect(result.stdout).toContain('dep: express');
  });

  // AC: Staleness warnings include record ID, date, first line, and trigger
  it('staleness warnings include ID, date, first line, and trigger', () => {
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    // Format: [shortId] (date) first line — triggered by: path
    expect(result.stdout).toMatch(/\[\w{8}\]/); // short ID
    expect(result.stdout).toMatch(/\(\d{4}-\d{2}-\d{2}\)/); // date
    expect(result.stdout).toMatch(/triggered by:/); // trigger info
  });

  // AC: `memnant recall` results include [stale] marker
  it('recall text output includes [stale] marker on stale records', () => {
    const result = runMemnant(['recall', 'authentication JWT'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[stale]');
  });

  // AC: `memnant recall --json` includes stale field
  it('recall --json includes stale boolean field', () => {
    const result = runMemnant(['recall', 'authentication JWT', '--json'], testDir);
    expect(result.status).toBe(0);
    const records = JSON.parse(result.stdout);
    expect(Array.isArray(records)).toBe(true);
    // At least one record should be stale
    const staleRecord = records.find((r: { stale: boolean }) => r.stale === true);
    expect(staleRecord).toBeDefined();
    // stale field should be a boolean
    for (const r of records) {
      expect(typeof r.stale).toBe('boolean');
    }
  });

  // AC: Staleness flags are transient — new snapshot clears all flags
  it('new snapshot clears staleness flags', () => {
    // Take a new snapshot (captures current state including changes)
    runMemnant(['snapshot'], testDir);

    // Now session start should not show stale decisions (no drift since snapshot)
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Potentially Stale Decisions');

    // Recall should also not show [stale]
    const recallResult = runMemnant(['recall', 'authentication JWT'], testDir);
    expect(recallResult.stdout).not.toContain('[stale]');
  });

  // AC: Stale records are still included in recall results (staleness is informational)
  it('stale records are still included in recall results', async () => {
    // Re-create drift by modifying a file again — semantically related to JWT decision
    await writeFile(join(testDir, 'src', 'auth.ts'), 'export function login() { /* replaced JWT authentication with OAuth2 bearer tokens */ }\n');

    const result = runMemnant(['recall', 'authentication JWT'], testDir);
    expect(result.status).toBe(0);
    // The decision should still appear (not filtered out)
    expect(result.stdout).toContain('decision');
    expect(result.stdout).toContain('[stale]');
  });

  // Edge case: no snapshot exists — no staleness detected
  it('no staleness when no snapshot exists', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-nostale-'));
    await writeFile(join(emptyDir, 'index.ts'), 'export const x = 1;\n');
    runMemnant(['init'], emptyDir);
    // Log a decision but don't take a snapshot
    runMemnant([
      'log', '--type', 'decision',
      '--content', 'Use React for the frontend in src/app.tsx',
    ], emptyDir);

    const result = runMemnant(['session', 'start', '--dry-run'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Potentially Stale Decisions');

    await rm(emptyDir, { recursive: true, force: true });
  });
});

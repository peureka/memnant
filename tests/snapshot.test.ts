/**
 * Tests for Story 3.1: Codebase Snapshots
 *
 * Integration tests for `memnant snapshot` and `memnant snapshot --diff`.
 * See docs/PLAN.md, Story 3.1 for the full AC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;
import { readFileSync, existsSync } from 'fs';
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

describe('memnant snapshot', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-snapshot-'));
    // Create project files
    await writeFile(join(testDir, 'index.ts'), 'export const main = () => {};\n');
    await writeFile(join(testDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    await mkdir(join(testDir, 'src'), { recursive: true });
    await writeFile(join(testDir, 'src', 'app.ts'), 'console.log("app");\n');
    await writeFile(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: { express: '^4.18.0' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2));

    // Init memnant
    runMemnant(['init'], testDir);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: snapshot generates a codebase_snapshot record with file tree, deps
  it('creates a codebase_snapshot record with files and dependencies', () => {
    const result = runMemnant(['snapshot'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('created');
    expect(result.stdout).toContain('files');

    // Verify the record in DB
    const db = openDb(testDir);
    const row = db.get(
      "SELECT content, content_text, type FROM record WHERE type = 'codebase_snapshot' ORDER BY created_at DESC LIMIT 1",
    ) as unknown as { content: string; content_text: string; type: string };
    expect(row.type).toBe('codebase_snapshot');

    const data = JSON.parse(row.content);
    expect(data).toHaveProperty('files');
    expect(data).toHaveProperty('dependencies');
    expect(data).toHaveProperty('file_count');
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.files.length).toBeGreaterThan(0);

    // Check that files have path and hash
    const firstFile = data.files[0];
    expect(firstFile).toHaveProperty('path');
    expect(firstFile).toHaveProperty('hash');

    // Check dependencies
    expect(data.dependencies).toHaveProperty('express');
    expect(data.dependencies).toHaveProperty('typescript');

    db.close();
  });

  // AC 2/3: .memnantignore is respected
  it('respects .memnantignore', async () => {
    await writeFile(join(testDir, '.memnantignore'), '*.log\ngenerated/\n');
    await writeFile(join(testDir, 'debug.log'), 'debug output\n');
    await mkdir(join(testDir, 'generated'), { recursive: true });
    await writeFile(join(testDir, 'generated', 'output.js'), 'generated code\n');

    const result = runMemnant(['snapshot'], testDir);
    expect(result.status).toBe(0);

    const db = openDb(testDir);
    const row = db.get(
      "SELECT content FROM record WHERE type = 'codebase_snapshot' ORDER BY created_at DESC LIMIT 1",
    ) as unknown as { content: string };
    const data = JSON.parse(row.content);
    const paths = data.files.map((f: { path: string }) => f.path);

    expect(paths).not.toContain('debug.log');
    expect(paths.some((p: string) => p.startsWith('generated/'))).toBe(false);

    db.close();

    // Clean up ignore file and extra files
    await rm(join(testDir, '.memnantignore'));
    await rm(join(testDir, 'debug.log'));
    await rm(join(testDir, 'generated'), { recursive: true });
  });

  // AC 4: content_text is human-readable summary
  it('content_text is a human-readable summary', () => {
    const db = openDb(testDir);
    const row = db.get(
      "SELECT content_text FROM record WHERE type = 'codebase_snapshot' ORDER BY created_at DESC LIMIT 1",
    ) as unknown as { content_text: string };

    expect(row.content_text).toMatch(/\d+ files/);
    expect(row.content_text).toMatch(/\d+ changed/);
    db.close();
  });

  // AC 5: --diff outputs changes without creating a record
  it('--diff shows changes without creating a record', async () => {
    const db = openDb(testDir);
    const before = (db.get("SELECT COUNT(*) as count FROM record WHERE type = 'codebase_snapshot'") as unknown as { count: number }).count;
    db.close();

    // Modify a file
    await writeFile(join(testDir, 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\n');

    const result = runMemnant(['snapshot', '--diff'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Modified:');
    expect(result.stdout).toContain('utils.ts');

    // No new record created
    const db2 = openDb(testDir);
    const after = (db2.get("SELECT COUNT(*) as count FROM record WHERE type = 'codebase_snapshot'") as unknown as { count: number }).count;
    db2.close();
    expect(after).toBe(before);
  });

  // AC 5b: --diff with no changes
  it('--diff reports no changes when nothing changed', () => {
    // Take a fresh snapshot first to sync state
    runMemnant(['snapshot'], testDir);

    const result = runMemnant(['snapshot', '--diff'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No changes since last snapshot.');
  });

  // AC 6: Old snapshots are pruned beyond max_codebase_snapshots (default 3)
  it('prunes old snapshots beyond max count', () => {
    // Create several snapshots (we already have some from prior tests)
    runMemnant(['snapshot'], testDir);
    runMemnant(['snapshot'], testDir);
    runMemnant(['snapshot'], testDir);
    runMemnant(['snapshot'], testDir);

    const db = openDb(testDir);
    const count = (db.get("SELECT COUNT(*) as count FROM record WHERE type = 'codebase_snapshot'") as unknown as { count: number }).count;
    expect(count).toBeLessThanOrEqual(3); // default max_codebase_snapshots
    db.close();
  });

  // No project → helpful error
  it('fails with helpful error when no project', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-noproject-'));
    const result = runMemnant(['snapshot'], emptyDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No memnant project found');
    await rm(emptyDir, { recursive: true, force: true });
  });
});

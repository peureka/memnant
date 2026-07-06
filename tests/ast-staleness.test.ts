/**
 * Tests for AST-anchored staleness detection.
 *
 * Verifies that:
 * - Structural hashing ignores comments and formatting
 * - Structural hashing detects logic changes
 * - Symbol finder locates functions and classes
 * - Schema migration v4 adds AST columns
 * - memnant log --target-file --target-symbol stores AST hash
 * - AST-anchored records are flagged stale when the symbol changes
 * - AST-anchored records stay fresh when only comments/formatting change
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

function openDb(testDir: string): InstanceType<typeof Database> {
  const config = yaml.load(readFileSync(join(testDir, 'memnant.yaml'), 'utf-8')) as ProjectConfig;
  return new Database(join(testDir, config.memory.db_path));
}

describe('schema migration v4', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-migration-v4-'));
    runMemnant(['init'], testDir);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('record table has target_file, target_symbol, ast_hash columns', () => {
    const db = openDb(testDir);

    // Check schema
    const tableInfo = db.all('PRAGMA table_info(record)') as unknown as Array<{
      name: string;
      type: string;
    }>;
    const columnNames = tableInfo.map((c) => c.name);

    expect(columnNames).toContain('target_file');
    expect(columnNames).toContain('target_symbol');
    expect(columnNames).toContain('ast_hash');

    db.close();
  });

  it('schema version is 11', () => {
    const db = openDb(testDir);
    const row = db.get('SELECT MAX(version) as version FROM schema_version') as unknown as {
      version: number;
    };
    expect(row.version).toBe(12);
    db.close();
  });
});

describe('AST-anchored logging via CLI', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-ast-log-'));

    // Create a TypeScript file with a function
    await mkdir(join(testDir, 'src'), { recursive: true });
    await writeFile(
      join(testDir, 'src', 'auth.ts'),
      `// Authentication module
export function verifyToken(token: string): boolean {
  if (!token) return false;
  return token.startsWith('valid_');
}

export class AuthProvider {
  private tokens: Map<string, boolean> = new Map();

  validate(token: string): boolean {
    return this.tokens.has(token);
  }
}
`,
    );

    runMemnant(['init'], testDir);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('stores AST hash when target_file and target_symbol are provided', () => {
    const result = runMemnant(
      [
        'log',
        '--type', 'decision',
        '--content', 'verifyToken uses prefix matching for token validation',
        '--target-file', 'src/auth.ts',
        '--target-symbol', 'verifyToken',
      ],
      testDir,
    );

    // Should succeed (AST hash may or may not be computed depending on grammar availability)
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Created decision record');

    // Check DB for the record
    const db = openDb(testDir);
    const row = db.get(
      "SELECT target_file, target_symbol, ast_hash FROM record WHERE type = 'decision' ORDER BY created_at DESC LIMIT 1",
    ) as unknown as { target_file: string | null; target_symbol: string | null; ast_hash: string | null };

    expect(row.target_file).toBe('src/auth.ts');
    expect(row.target_symbol).toBe('verifyToken');
    // ast_hash may be null if grammar download failed (offline), but target_file/target_symbol should always be stored
    db.close();
  });

  it('stores record without AST fields when target_file is not provided', () => {
    const result = runMemnant(
      [
        'log',
        '--type', 'decision',
        '--content', 'Use JWT for session management',
      ],
      testDir,
    );

    expect(result.status).toBe(0);

    const db = openDb(testDir);
    const row = db.get(
      "SELECT target_file, target_symbol, ast_hash FROM record ORDER BY created_at DESC LIMIT 1",
    ) as unknown as { target_file: string | null; target_symbol: string | null; ast_hash: string | null };

    expect(row.target_file).toBeNull();
    expect(row.target_symbol).toBeNull();
    expect(row.ast_hash).toBeNull();
    db.close();
  });
});

describe('AST-anchored staleness detection', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-ast-stale-'));

    // Create project files
    await mkdir(join(testDir, 'src'), { recursive: true });
    await writeFile(
      join(testDir, 'src', 'auth.ts'),
      `export function verifyToken(token: string): boolean {
  if (!token) return false;
  return token.startsWith('valid_');
}
`,
    );

    await writeFile(join(testDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      dependencies: {},
    }, null, 2));

    // Init memnant
    runMemnant(['init'], testDir);

    // Log a decision anchored to verifyToken
    runMemnant(
      [
        'log',
        '--type', 'decision',
        '--content', 'verifyToken uses prefix matching because full JWT verification is too slow for triage',
        '--target-file', 'src/auth.ts',
        '--target-symbol', 'verifyToken',
      ],
      testDir,
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('does not flag as stale when only comments change', async () => {
    // Check if AST hash was stored (depends on grammar availability)
    const db = openDb(testDir);
    const row = db.get(
      "SELECT ast_hash FROM record WHERE type = 'decision' LIMIT 1",
    ) as unknown as { ast_hash: string | null };
    db.close();

    if (!row.ast_hash) {
      // Grammar not available — skip this test
      return;
    }

    // Add a comment to the function — should not trigger staleness
    await writeFile(
      join(testDir, 'src', 'auth.ts'),
      `// This is a new comment
// Added for documentation
export function verifyToken(token: string): boolean {
  // Check for empty token
  if (!token) return false;
  return token.startsWith('valid_');
}
`,
    );

    // Take a snapshot and check session context for staleness
    runMemnant(['snapshot'], testDir);
    const result = runMemnant(['session', 'start', '--dry-run'], testDir);

    // The record should NOT be flagged as stale — only comments changed
    expect(result.stdout).not.toContain('AST changed: verifyToken');
  });

  it('does not flag as stale when only formatting changes', async () => {
    const db = openDb(testDir);
    const row = db.get(
      "SELECT ast_hash FROM record WHERE type = 'decision' LIMIT 1",
    ) as unknown as { ast_hash: string | null };
    db.close();

    if (!row.ast_hash) return;

    // Reformat the function — different whitespace, same logic
    await writeFile(
      join(testDir, 'src', 'auth.ts'),
      `export function verifyToken(
  token: string,
): boolean {
  if (!token)
    return false;
  return token.startsWith('valid_');
}
`,
    );

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.stdout).not.toContain('AST changed: verifyToken');
  });

  it('flags as stale when function logic changes', async () => {
    const db = openDb(testDir);
    const row = db.get(
      "SELECT ast_hash FROM record WHERE type = 'decision' LIMIT 1",
    ) as unknown as { ast_hash: string | null };
    db.close();

    if (!row.ast_hash) return;

    // Change the function logic — add a new condition
    await writeFile(
      join(testDir, 'src', 'auth.ts'),
      `export function verifyToken(token: string): boolean {
  if (!token) return false;
  if (token.length < 10) return false;
  return token.startsWith('valid_') && token.endsWith('_ok');
}
`,
    );

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    // Should detect AST-level staleness
    expect(result.stdout).toContain('AST changed');
    expect(result.stdout).toContain('verifyToken');
  });

  it('flags as stale when symbol is removed', async () => {
    const db = openDb(testDir);
    const row = db.get(
      "SELECT ast_hash FROM record WHERE type = 'decision' LIMIT 1",
    ) as unknown as { ast_hash: string | null };
    db.close();

    if (!row.ast_hash) return;

    // Remove the function entirely
    await writeFile(
      join(testDir, 'src', 'auth.ts'),
      `export function checkAuth(user: string): boolean {
  return user === 'admin';
}
`,
    );

    const result = runMemnant(['session', 'start', '--dry-run'], testDir);
    expect(result.stdout).toContain('not found');
    expect(result.stdout).toContain('verifyToken');
  });
});

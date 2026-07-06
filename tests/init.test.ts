/**
 * Tests for Story 1.1: Project Initialisation
 *
 * These tests verify the acceptance criteria for `memnant init` and `memnant status`.
 * See docs/PLAN.md, Story 1.1 for the full AC.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;
import type { ProjectConfig } from '../src/types.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
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

describe('memnant init', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates memnant.yaml with sensible defaults', () => {
    runMemnant(['init'], testDir);
    const configPath = join(testDir, 'memnant.yaml');
    expect(existsSync(configPath)).toBe(true);

    const config = yaml.load(readFileSync(configPath, 'utf-8')) as ProjectConfig;
    expect(config.project.name).toBe(testDir.split('/').pop());
    expect(config.memory.db_path).toBe('.memnant/ledger.db');
    expect(config.memory.export_path).toBe('.memnant/export/');
    expect(config.memory.snapshot_interval).toBe('monthly');
    expect(config.memory.max_spec_snapshots).toBe(5);
    expect(config.memory.max_codebase_snapshots).toBe(3);
    expect(config.orchestrator.interfaces.mcp.port).toBe(3100);
    expect(config.governor.docs_path).toBe('docs/');
    expect(config.security.staging_only).toBe(true);
    expect(config.security.allow_deploy).toBe(false);
  });

  it('creates .memnant/ directory with ledger.db', () => {
    runMemnant(['init'], testDir);
    const dbPath = join(testDir, '.memnant', 'ledger.db');
    expect(existsSync(dbPath)).toBe(true);
  });

  it('exits without modification if memnant.yaml already exists', () => {
    // First init
    runMemnant(['init'], testDir);
    const configPath = join(testDir, 'memnant.yaml');
    const originalContent = readFileSync(configPath, 'utf-8');

    // Second init
    const result = runMemnant(['init'], testDir);
    expect(result.stdout).toContain('memnant is already initialised in this project.');

    // Config unchanged
    expect(readFileSync(configPath, 'utf-8')).toBe(originalContent);
  });

  it('generates a UUID for project.id', () => {
    runMemnant(['init'], testDir);
    const config = yaml.load(
      readFileSync(join(testDir, 'memnant.yaml'), 'utf-8'),
    ) as ProjectConfig;

    // UUID v4 format
    expect(config.project.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('prints .gitignore suggestion', () => {
    const result = runMemnant(['init'], testDir);
    expect(result.stdout).toContain(
      'Add `.memnant/` to your .gitignore',
    );
  });

  it('creates database with correct schema (Project, Record, Session tables)', () => {
    runMemnant(['init'], testDir);
    const dbPath = join(testDir, '.memnant', 'ledger.db');
    const db = new Database(dbPath);

    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") as unknown as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('project');
    expect(tableNames).toContain('record');
    expect(tableNames).toContain('session');

    // Verify project row was inserted
    const project = db.get('SELECT * FROM project') as unknown as {
      id: string;
      name: string;
    };
    expect(project).toBeDefined();
    expect(project.name).toBe(testDir.split('/').pop());

    db.close();
  });

  it('memnant status works after init', () => {
    runMemnant(['init'], testDir);
    const result = runMemnant(['status'], testDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Project:');
    expect(result.stdout).toContain('Records: 0');
    expect(result.stdout).toContain('Sessions: 0');
    expect(result.stdout).toContain('Ledger size:');
  });

  it('memnant status fails without init', () => {
    const result = runMemnant(['status'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No memnant project found');
  });

  it('--with-specs creates three starter spec files', () => {
    const result = runMemnant(['init', '--with-specs'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Created starter specs in docs/');

    const docsDir = join(testDir, 'docs');
    expect(existsSync(join(docsDir, 'copy-style.md'))).toBe(true);
    expect(existsSync(join(docsDir, 'design-system.md'))).toBe(true);
    expect(existsSync(join(docsDir, 'persona-user.md'))).toBe(true);

    // Verify content has frontmatter
    const copyStyle = readFileSync(join(docsDir, 'copy-style.md'), 'utf-8');
    expect(copyStyle).toContain('type: copy_audit');
    expect(copyStyle).toContain('Banned Phrases');

    const designSystem = readFileSync(join(docsDir, 'design-system.md'), 'utf-8');
    expect(designSystem).toContain('type: design_system');

    const persona = readFileSync(join(docsDir, 'persona-user.md'), 'utf-8');
    expect(persona).toContain('type: persona');
    expect(persona).toContain('Test Questions');
  });

  it('without --with-specs does not create docs/', () => {
    runMemnant(['init'], testDir);
    expect(existsSync(join(testDir, 'docs'))).toBe(false);
  });

  it('--with-specs does not overwrite existing spec files', () => {
    // Create docs/ with an existing file
    const docsDir = join(testDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'copy-style.md'), 'custom content', 'utf-8');

    runMemnant(['init', '--with-specs'], testDir);

    // Existing file should be preserved
    expect(readFileSync(join(docsDir, 'copy-style.md'), 'utf-8')).toBe('custom content');
    // Other files should be created
    expect(existsSync(join(docsDir, 'design-system.md'))).toBe(true);
    expect(existsSync(join(docsDir, 'persona-user.md'))).toBe(true);
  });
});

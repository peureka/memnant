/**
 * Tests for portable framework fix export/import.
 *
 * Feature 2: Cross-project framework fixes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
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

describe('memnant export --format portable', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-portable-'));
    runMemnant(['init'], testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('exports only framework_fix records with --type', () => {
    runMemnant(['log', '--type', 'decision', '--content', 'Use React'], testDir);
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Next.js caching bug'], testDir);

    const result = runMemnant(['export', '--type', 'framework_fix', '--format', 'portable'], testDir);
    expect(result.status).toBe(0);

    const portablePath = join(testDir, '.memnant', 'export', 'framework-fixes.portable.json');
    expect(existsSync(portablePath)).toBe(true);
  });

  it('portable JSON has correct structure', async () => {
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Next.js caching bug'], testDir);

    runMemnant(['export', '--type', 'framework_fix', '--format', 'portable'], testDir);

    const portablePath = join(testDir, '.memnant', 'export', 'framework-fixes.portable.json');
    const data = JSON.parse(await readFile(portablePath, 'utf-8'));

    expect(data).toHaveProperty('memnant_version');
    expect(data).toHaveProperty('source_project');
    expect(data).toHaveProperty('exported_at');
    expect(data).toHaveProperty('record_count', 1);
    expect(data.records).toHaveLength(1);
    expect(data.records[0]).toHaveProperty('type', 'framework_fix');
    expect(data.records[0]).toHaveProperty('content_text');
    expect(data.records[0]).toHaveProperty('tags');
    expect(data.records[0]).toHaveProperty('original_id');
    expect(data.records[0]).toHaveProperty('created_at');
    // Should NOT have project-specific fields
    expect(data.records[0]).not.toHaveProperty('project_id');
    expect(data.records[0]).not.toHaveProperty('embedding');
    expect(data.records[0]).not.toHaveProperty('related_records');
  });

  it('--type filters records in existing formats too', () => {
    runMemnant(['log', '--type', 'decision', '--content', 'Use React'], testDir);
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Cache bug'], testDir);

    const result = runMemnant(['export', '--type', 'framework_fix', '--format', 'json'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Exported 1 records');
  });

  it('rejects invalid --type', () => {
    const result = runMemnant(['export', '--type', 'invalid_type'], testDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown record type');
  });

  it('prints record count', () => {
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Fix A'], testDir);
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Fix B'], testDir);

    const result = runMemnant(['export', '--type', 'framework_fix', '--format', 'portable'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Exported 2');
  });

  it('exports notebooklm format as single markdown file', async () => {
    runMemnant(['log', '--type', 'decision', '--content', 'Use React over Vue'], testDir);
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Next.js caching bug fix'], testDir);

    const result = runMemnant(['export', '--format', 'notebooklm'], testDir);
    expect(result.status).toBe(0);

    const mdPath = join(testDir, '.memnant', 'export', 'notebooklm.md');
    expect(existsSync(mdPath)).toBe(true);

    const content = await readFile(mdPath, 'utf-8');
    expect(content).toContain('# ');
    expect(content).toContain('## Decisions (1)');
    expect(content).toContain('## Framework Fixes (1)');
    expect(content).toContain('Use React over Vue');
    expect(content).toContain('Next.js caching bug fix');
  });
});

describe('memnant import', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), 'memnant-source-'));
    targetDir = await mkdtemp(join(tmpdir(), 'memnant-target-'));
    runMemnant(['init'], sourceDir);
    runMemnant(['init'], targetDir);
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  });

  it('imports framework fixes from portable file', () => {
    // Log fixes in source project
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Next.js caching workaround'], sourceDir);
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Tailwind purge config fix'], sourceDir);

    // Export from source
    runMemnant(['export', '--type', 'framework_fix', '--format', 'portable'], sourceDir);

    // Import into target
    const portablePath = join(sourceDir, '.memnant', 'export', 'framework-fixes.portable.json');
    const result = runMemnant(['import', portablePath], targetDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Imported 2 framework fixes');
  });

  it('skips duplicate records on re-import', () => {
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Cache fix'], sourceDir);
    runMemnant(['export', '--type', 'framework_fix', '--format', 'portable'], sourceDir);

    const portablePath = join(sourceDir, '.memnant', 'export', 'framework-fixes.portable.json');

    // Import twice
    runMemnant(['import', portablePath], targetDir);
    const result = runMemnant(['import', portablePath], targetDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 framework fixes');
    expect(result.stdout).toContain('1 skipped');
  });

  it('adds imported and source project tags', () => {
    runMemnant(['log', '--type', 'framework_fix', '--content', 'Cache fix'], sourceDir);
    runMemnant(['export', '--type', 'framework_fix', '--format', 'portable'], sourceDir);

    const portablePath = join(sourceDir, '.memnant', 'export', 'framework-fixes.portable.json');
    runMemnant(['import', portablePath], targetDir);

    // Recall to verify tags
    const result = runMemnant(['recall', 'cache fix', '--json'], targetDir);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].tags).toContain('imported');
  });

  it('rejects non-framework_fix records', async () => {
    // Manually create a portable file with a decision record
    const badFile = join(targetDir, 'bad.json');
    await writeFile(badFile, JSON.stringify({
      memnant_version: '0.1.0',
      source_project: 'test',
      exported_at: new Date().toISOString(),
      record_count: 1,
      records: [{
        type: 'decision',
        content_text: 'This should fail',
        tags: [],
        original_id: 'abc',
        created_at: new Date().toISOString(),
      }],
    }));

    const result = runMemnant(['import', badFile], targetDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Only framework_fix');
  });

  it('rejects invalid file structure', () => {
    const result = runMemnant(['import', '/nonexistent/file.json'], targetDir);
    expect(result.status).toBe(1);
  });

  it('fails without project', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-noimport-'));
    const result = runMemnant(['import', 'whatever.json'], emptyDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No memnant project found');
    await rm(emptyDir, { recursive: true, force: true });
  });
});

/**
 * Tests for Story 1.2: Write Records
 *
 * These tests verify the acceptance criteria for `memnant log`.
 * See docs/PLAN.md, Story 1.2 for the full AC.
 *
 * Timeout is extended to handle first-time embedding model download.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { input?: string; timeout?: number },
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 120_000,
      input: opts?.input,
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

interface RecordRow {
  id: string;
  project_id: string;
  type: string;
  content: string;
  content_text: string;
  embedding: Uint8Array | null;
  tags: string;
  related_records: string;
  created_at: string;
  source_session: string | null;
}

describe('memnant log', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-test-'));
    runMemnant(['init'], testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: Basic record creation (type, content, UUID, timestamps)
  it('creates a record with type, content, UUID, and timestamp', () => {
    const result = runMemnant(
      ['log', '--type', 'decision', '--content', 'We chose snapshot-first analytics'],
      testDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Created decision record');

    // Extract the UUID from output
    const match = result.stdout.match(/Created decision record ([0-9a-f-]+)/);
    expect(match).not.toBeNull();
    const recordId = match![1];

    // Verify in database
    const db = new Database(join(testDir, '.memnant', 'ledger.db'));
    const row = db.get('SELECT * FROM record WHERE id = ?', [recordId]) as unknown as RecordRow;

    expect(row.type).toBe('decision');
    expect(row.content_text).toBe('We chose snapshot-first analytics');
    expect(JSON.parse(row.content)).toEqual({ text: 'We chose snapshot-first analytics' });
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    db.close();
  });

  // AC 2: Tags stored as string array
  it('stores tags as a string array', () => {
    const result = runMemnant(
      ['log', '--type', 'framework_fix', '--content', 'Fix routing issue', '--tags', 'nextjs,routing'],
      testDir,
    );

    expect(result.status).toBe(0);

    const db = new Database(join(testDir, '.memnant', 'ledger.db'));
    const row = db.get('SELECT tags FROM record') as unknown as { tags: string };
    expect(JSON.parse(row.tags)).toEqual(['nextjs', 'routing']);
    db.close();
  });

  // AC 3: --relates-to stores related record IDs
  it('stores related record IDs from --relates-to', () => {
    // Create a first record
    const first = runMemnant(
      ['log', '--type', 'decision', '--content', 'First decision'],
      testDir,
    );
    const firstId = first.stdout.match(/record ([0-9a-f-]+)/)![1];

    // Create a second record that relates to the first
    const result = runMemnant(
      ['log', '--type', 'decision', '--content', 'Supersedes first', '--relates-to', firstId],
      testDir,
    );
    expect(result.status).toBe(0);

    const db = new Database(join(testDir, '.memnant', 'ledger.db'));
    const rows = db.all('SELECT related_records FROM record ORDER BY created_at DESC') as unknown as {
      related_records: string;
    }[];
    expect(JSON.parse(rows[0].related_records)).toEqual([firstId]);
    db.close();
  });

  // AC 4: All 5 spec-defined record types accepted (plus orchestrator_task)
  it('accepts all spec-defined record types', () => {
    const types = ['session_log', 'decision', 'framework_fix', 'spec_snapshot', 'codebase_snapshot'];
    for (const type of types) {
      const result = runMemnant(
        ['log', '--type', type, '--content', `Test ${type}`],
        testDir,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Created ${type} record`);
    }

    // Verify count
    const db = new Database(join(testDir, '.memnant', 'ledger.db'));
    const count = (db.get('SELECT COUNT(*) as count FROM record') as unknown as { count: number })
      .count;
    expect(count).toBe(types.length);
    db.close();
  });

  // AC 5: Unknown record types rejected with helpful error
  it('rejects unknown record types with helpful error', () => {
    const result = runMemnant(
      ['log', '--type', 'note', '--content', 'Should fail'],
      testDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown record type 'note'");
    expect(result.stderr).toContain('Valid types:');
    expect(result.stderr).toContain('session_log');
    expect(result.stderr).toContain('decision');
    expect(result.stderr).toContain('framework_fix');
    expect(result.stderr).toContain('spec_snapshot');
    expect(result.stderr).toContain('codebase_snapshot');
  });

  // AC 6: Stdin pipe support
  it('accepts content piped from stdin', () => {
    const result = runMemnant(['log', '--type', 'decision'], testDir, {
      input: 'Piped content from stdin',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Created decision record');

    const db = new Database(join(testDir, '.memnant', 'ledger.db'));
    const row = db.get('SELECT content_text FROM record') as unknown as { content_text: string };
    expect(row.content_text).toBe('Piped content from stdin');
    db.close();
  });

  // AC 7: Embedding exists (BLOB column, 1536 bytes = 384 floats * 4 bytes)
  it('stores an embedding as a 1536-byte BLOB (384 float32s)', () => {
    runMemnant(
      ['log', '--type', 'decision', '--content', 'Test embedding generation'],
      testDir,
    );

    const db = new Database(join(testDir, '.memnant', 'ledger.db'));
    const row = db.get('SELECT embedding FROM record') as unknown as { embedding: Uint8Array };

    expect(row.embedding).not.toBeNull();
    expect(row.embedding.length).toBe(384 * 4); // 384 float32 values * 4 bytes each
    db.close();
  });

  // AC 8: Stdout prints record ID and type
  it('prints record ID and type to stdout', () => {
    const result = runMemnant(
      ['log', '--type', 'framework_fix', '--content', 'Test output format'],
      testDir,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /Created framework_fix record [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
    );
  });

  // AC 9: No edit/update commands exist (immutability by absence)
  it('has no edit or update commands', () => {
    const editResult = runMemnant(['edit'], testDir, { timeout: 5000 });
    expect(editResult.status).not.toBe(0);

    const updateResult = runMemnant(['update'], testDir, { timeout: 5000 });
    expect(updateResult.status).not.toBe(0);
  });

  it('errors when no content is provided and stdin is a TTY', () => {
    // When running without input and without --content, should fail.
    // The test process stdin IS a TTY from execFileSync's perspective when no input is given.
    const result = runMemnant(['log', '--type', 'decision'], testDir, { timeout: 5000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No content provided');
  });
});

/**
 * Tests for Story 2.2: Session Close with Log Capture
 *
 * Integration tests that verify `memnant session close` captures logs,
 * handles --skip, and prints summaries.
 *
 * See docs/PLAN.md, Story 2.2 for the full AC.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
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

describe('memnant session close', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-session-close-'));
    runMemnant(['init'], testDir);
  });

  beforeEach(() => {
    // Clean up any active sessions before each test
    const db = openDb(testDir);
    db.run("UPDATE session SET closed_at = datetime('now'), log_skipped = 'test cleanup' WHERE closed_at IS NULL");
    db.close();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: session close --log closes session and creates session_log record
  it('--log closes session and creates session_log record', () => {
    runMemnant(['session', 'start'], testDir);

    const result = runMemnant(
      ['session', 'close', '--log', 'Shipped auth flow. Decided JWT over sessions.'],
      testDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('closed');

    // Verify session is closed with log_record_id
    const db = openDb(testDir);
    const session = db.get(
      'SELECT * FROM session WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1',
    ) as unknown as { log_record_id: string | null; log_skipped: string | null };
    expect(session.log_record_id).not.toBeNull();
    expect(session.log_skipped).toBeNull();

    // Verify session_log record was created
    const record = db.get(
      'SELECT * FROM record WHERE id = ?', [session.log_record_id!],
    ) as unknown as { type: string; content_text: string };
    expect(record.type).toBe('session_log');
    expect(record.content_text).toContain('Shipped auth flow');

    db.close();
  });

  // AC 2: Piped input works
  it('piped input works', () => {
    runMemnant(['session', 'start'], testDir);

    const result = runMemnant(
      ['session', 'close'],
      testDir,
      { input: 'Piped session log content from stdin' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('closed');

    const db = openDb(testDir);
    const session = db.get(
      'SELECT * FROM session WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1',
    ) as unknown as { log_record_id: string | null };
    expect(session.log_record_id).not.toBeNull();

    const record = db.get(
      'SELECT content_text FROM record WHERE id = ?', [session.log_record_id!],
    ) as unknown as { content_text: string };
    expect(record.content_text).toContain('Piped session log content');

    db.close();
  });

  // AC 3: --skip "reason" closes without log, sets log_skipped, prints warning
  it('--skip closes without log and prints warning', () => {
    runMemnant(['session', 'start'], testDir);

    const result = runMemnant(
      ['session', 'close', '--skip', 'exploratory, nothing shipped'],
      testDir,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('without log');
    expect(result.stderr).toContain('not be available');

    const db = openDb(testDir);
    const session = db.get(
      'SELECT * FROM session WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1',
    ) as unknown as { log_record_id: string | null; log_skipped: string | null };
    expect(session.log_record_id).toBeNull();
    expect(session.log_skipped).toBe('exploratory, nothing shipped');

    db.close();
  });

  // AC 4: --skip with no reason is rejected
  it('--skip with no reason is rejected', () => {
    runMemnant(['session', 'start'], testDir);

    const result = runMemnant(
      ['session', 'close', '--skip'],
      testDir,
    );
    // Commander treats --skip without value as a boolean flag that eats the next token,
    // or just sets it to true if there's no next arg
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reason');
  });

  // AC 5: No active session → "No active session to close."
  it('prints message when no active session', () => {
    const result = runMemnant(['session', 'close'], testDir, { input: '' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No active session to close.');
  });

  // AC 6: Close prints summary with duration and record counts
  it('prints summary with duration and record counts', () => {
    runMemnant(['session', 'start'], testDir);

    const result = runMemnant(
      ['session', 'close', '--log', 'Test session log for summary'],
      testDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Duration:');
    expect(result.stdout).toContain('Records created:');
  });

  // AC 7: Session record has correct closed_at and log_record_id after close
  it('session record has correct closed_at and log_record_id', () => {
    runMemnant(['session', 'start'], testDir);

    const db = openDb(testDir);
    const activeBefore = db.get('SELECT id FROM session WHERE closed_at IS NULL') as unknown as { id: string };
    const sessionId = activeBefore.id;
    db.close();

    runMemnant(
      ['session', 'close', '--log', 'Verifying session record fields'],
      testDir,
    );

    const db2 = openDb(testDir);
    const session = db2.get('SELECT * FROM session WHERE id = ?', [sessionId]) as unknown as {
      closed_at: string | null;
      log_record_id: string | null;
      log_skipped: string | null;
    };
    expect(session.closed_at).not.toBeNull();
    expect(session.log_record_id).not.toBeNull();
    expect(session.log_skipped).toBeNull();

    // Verify the log record exists and is linked
    const record = db2.get(
      'SELECT type, source_session FROM record WHERE id = ?', [session.log_record_id!],
    ) as unknown as { type: string; source_session: string };
    expect(record.type).toBe('session_log');
    expect(record.source_session).toBe(sessionId);

    db2.close();
  });
});

/**
 * Tests for CLI `memnant session close` team export parity.
 *
 * The MCP session_close already exports shareable records to .memnant/shared/;
 * the CLI close must do the same whenever a builder is configured (team mode),
 * and no-op silently otherwise.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
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
  const r = spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf-8', timeout: 120_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

function openDb(dir: string): InstanceType<typeof Database> {
  const config = yaml.load(readFileSync(join(dir, 'memnant.yaml'), 'utf-8')) as ProjectConfig;
  return new Database(join(dir, config.memory.db_path));
}

function activeSessionId(dir: string): string {
  const db = openDb(dir);
  const row = db.get('SELECT id FROM session WHERE closed_at IS NULL') as unknown as { id: string };
  db.close();
  return row.id;
}

function insertDecision(dir: string, id: string, sessionId: string, text: string): void {
  const config = yaml.load(readFileSync(join(dir, 'memnant.yaml'), 'utf-8')) as ProjectConfig;
  const db = openDb(dir);
  db.run(
    `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, source_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, config.project.id, 'decision', '{}', text, '["api"]', '[]', new Date().toISOString(), sessionId],
  );
  db.close();
}

describe('memnant session close — team export parity', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-close-export-'));
    execFileSync('git', ['init'], { cwd: testDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test Builder'], { cwd: testDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Test 5
  it('with a builder configured, exports the session shareable records to .memnant/shared/', () => {
    runMemnant(['init', '--non-interactive', '--team'], testDir);
    runMemnant(['session', 'start'], testDir);
    const sessionId = activeSessionId(testDir);
    insertDecision(testDir, 'rec-close-1', sessionId, 'Use Postgres over MySQL for the ledger');

    const result = runMemnant(['session', 'close', '--log', 'Shipped the ledger schema.'], testDir);
    expect(result.status).toBe(0);

    const sharedFile = join(testDir, '.memnant', 'shared', 'rec-close-1.json');
    expect(existsSync(sharedFile)).toBe(true);
    const shared = JSON.parse(readFileSync(sharedFile, 'utf-8'));
    expect(shared.type).toBe('decision');
    expect(shared.content_text).toBe('Use Postgres over MySQL for the ledger');
    expect(shared.builder_id).toBe('Test Builder');
  });

  // Test 6 (regression)
  it('with no builder configured, writes nothing to shared/', () => {
    runMemnant(['init', '--non-interactive'], testDir);
    runMemnant(['session', 'start'], testDir);
    const sessionId = activeSessionId(testDir);
    insertDecision(testDir, 'rec-close-2', sessionId, 'Use Redis for the queue');

    const result = runMemnant(['session', 'close', '--log', 'Solo work, no team.'], testDir);
    expect(result.status).toBe(0);

    expect(existsSync(join(testDir, '.memnant', 'shared'))).toBe(false);
  });

  // Test 7 (idempotency)
  it('does not overwrite a shared record that is already present', () => {
    runMemnant(['init', '--non-interactive', '--team'], testDir);
    runMemnant(['session', 'start'], testDir);
    const sessionId = activeSessionId(testDir);
    insertDecision(testDir, 'rec-close-3', sessionId, 'Use gRPC between services');

    const sharedDir = join(testDir, '.memnant', 'shared');
    mkdirSync(sharedDir, { recursive: true });
    const sharedFile = join(sharedDir, 'rec-close-3.json');
    writeFileSync(sharedFile, '{"sentinel":true}');

    const result = runMemnant(['session', 'close', '--log', 'Second pass.'], testDir);
    expect(result.status).toBe(0);

    // Pre-existing file left untouched.
    expect(readFileSync(sharedFile, 'utf-8')).toBe('{"sentinel":true}');
  });
});

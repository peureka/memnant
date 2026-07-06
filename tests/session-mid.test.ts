/**
 * Tests for Story 2.4: Mid-Session Logging
 *
 * Integration tests that verify records logged during an active session
 * automatically get source_session set, and that session status works.
 *
 * See docs/PLAN.md, Story 2.4 for the full AC.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

describe('memnant mid-session logging', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-session-mid-'));
    runMemnant(['init'], testDir);
  });

  beforeEach(() => {
    // Clean up any active sessions
    const db = openDb(testDir);
    db.run("UPDATE session SET closed_at = datetime('now'), log_skipped = 'test cleanup' WHERE closed_at IS NULL");
    db.close();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC 1: memnant log during active session sets source_session
  it('CLI log during active session sets source_session', () => {
    runMemnant(['session', 'start'], testDir);

    // Get the active session ID
    const db = openDb(testDir);
    const session = db.get('SELECT id FROM session WHERE closed_at IS NULL') as unknown as { id: string };
    db.close();

    // Log a record
    const logResult = runMemnant(
      ['log', '--type', 'decision', '--content', 'Mid-session decision: use Redis for caching'],
      testDir,
    );
    expect(logResult.status).toBe(0);

    // Verify the record has source_session set
    const db2 = openDb(testDir);
    const record = db2.get(
      "SELECT source_session FROM record WHERE content_text LIKE '%Redis for caching%'",
    ) as unknown as { source_session: string | null };
    expect(record.source_session).toBe(session.id);
    db2.close();
  });

  // AC 2: MCP memnant_log during active session sets source_session
  it('MCP log during active session sets source_session', async () => {
    runMemnant(['session', 'start'], testDir);

    const db = openDb(testDir);
    const session = db.get('SELECT id FROM session WHERE closed_at IS NULL') as unknown as { id: string };
    db.close();

    // Connect MCP client
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, 'serve'],
      cwd: testDir,
    });
    const client = new Client({ name: 'test-mid-session', version: '0.1.0' });
    await client.connect(transport);

    // Log via MCP
    await client.callTool({
      name: 'memnant_log',
      arguments: {
        type: 'framework_fix',
        content: 'MCP mid-session fix: Next.js caching issue in API routes',
      },
    });

    await client.close();

    // Verify source_session
    const db2 = openDb(testDir);
    const record = db2.get(
      "SELECT source_session FROM record WHERE content_text LIKE '%MCP mid-session fix%'",
    ) as unknown as { source_session: string | null };
    expect(record.source_session).toBe(session.id);
    db2.close();
  });

  // AC 3: memnant session status shows session info and record counts
  it('session status shows session info and record counts', () => {
    runMemnant(['session', 'start'], testDir);

    // Log a couple records
    runMemnant(
      ['log', '--type', 'decision', '--content', 'Status test decision'],
      testDir,
    );
    runMemnant(
      ['log', '--type', 'framework_fix', '--content', 'Status test fix'],
      testDir,
    );

    const result = runMemnant(['session', 'status'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Session:');
    expect(result.stdout).toContain('Started:');
    expect(result.stdout).toContain('Duration:');
    expect(result.stdout).toContain('Records:');
    expect(result.stdout).toContain('decision: 1');
    expect(result.stdout).toContain('framework_fix: 1');
  });

  // AC 4: Records logged mid-session are immediately available via memnant recall
  it('mid-session records are immediately available via recall', () => {
    runMemnant(['session', 'start'], testDir);

    runMemnant(
      ['log', '--type', 'decision', '--content', 'Unique mid-session recall test content xyz789'],
      testDir,
    );

    const result = runMemnant(['recall', 'xyz789 recall test'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Unique mid-session recall test content');
  });

  // AC 5: No active session → session status prints "No active session."
  it('session status with no active session', () => {
    const result = runMemnant(['session', 'status'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No active session.');
  });
});

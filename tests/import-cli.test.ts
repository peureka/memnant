/**
 * CLI-level tests for `memnant import` with interchange files.
 *
 * These spawn the compiled CLI (dist/), like portable-export.test.ts, which
 * covers the legacy portable-file path of the same command.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { openDatabase } from '../src/ledger/database.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf-8', timeout: 180_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

describe('memnant import — interchange files', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'memnant-import-cli-'));
    runMemnant(['init'], projectDir);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('imports a conversation file and reports the funnel', () => {
    const file = join(projectDir, 'conversation.json');
    writeFileSync(
      file,
      JSON.stringify({
        memnant_interchange: 1,
        source: {
          provider: 'chatgpt',
          title: 'Queue technology choice',
          url: 'https://chatgpt.com/c/abc',
        },
        messages: [
          { role: 'user', text: "Let's go with BullMQ for the background job queue." },
          { role: 'assistant', text: 'BullMQ on the existing Redis instance keeps the operational surface small.' },
        ],
      }),
    );

    const result = runMemnant(['import', 'conversation.json'], projectDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('chatgpt conversation "Queue technology choice"');
    expect(result.stdout).toMatch(/2 messages → \d+ candidates → \d+ records written/);

    const db = openDatabase(join(projectDir, '.memnant', 'ledger.db'));
    const rows = db.all("SELECT content, tags FROM record WHERE type = 'decision'") as unknown as Array<{
      content: string;
      tags: string;
    }>;
    db.close();

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(rows[0].tags)).toContain('from:chatgpt');
    expect(JSON.parse(rows[0].content).origin.url).toBe('https://chatgpt.com/c/abc');
  }, 120000);

  it('imports a pre-extracted records bundle', () => {
    const file = join(projectDir, 'decisions.json');
    writeFileSync(
      file,
      JSON.stringify({
        memnant_interchange: 1,
        source: { provider: 'copilot' },
        records: [
          { type: 'decision', content: 'Chose Playwright over Cypress for end-to-end tests: parallelism and trace viewer.', tags: ['testing'] },
        ],
      }),
    );

    const result = runMemnant(['import', 'decisions.json'], projectDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Imported 1 of 1 records from copilot');
  }, 120000);

  it('rejects an invalid interchange file with pointed errors', () => {
    const file = join(projectDir, 'bad.json');
    writeFileSync(
      file,
      JSON.stringify({
        memnant_interchange: 1,
        source: { provider: 'chatgpt' },
        messages: [{ role: 'system', text: 'You are a helpful assistant.' }],
      }),
    );

    const result = runMemnant(['import', 'bad.json'], projectDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('messages[0]');

    const db = openDatabase(join(projectDir, '.memnant', 'ledger.db'));
    const count = db.get('SELECT COUNT(*) as n FROM record') as unknown as { n: number };
    db.close();
    expect(count.n).toBe(0);
  }, 120000);

  it('--dry-run reports without writing', () => {
    const file = join(projectDir, 'dry.json');
    writeFileSync(
      file,
      JSON.stringify({
        memnant_interchange: 1,
        source: { provider: 'claude' },
        records: [{ type: 'framework_fix', content: 'Vitest worker RPC starves under full parallelism; cap maxWorkers.' }],
      }),
    );

    const result = runMemnant(['import', '--dry-run', 'dry.json'], projectDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Would import 1 of 1 records');
    expect(result.stdout).toContain('[framework_fix]');
    expect(result.stdout).toContain('Vitest worker RPC starves');
    expect(result.stdout).toContain('Dry run — nothing was written.');

    const db = openDatabase(join(projectDir, '.memnant', 'ledger.db'));
    const count = db.get('SELECT COUNT(*) as n FROM record') as unknown as { n: number };
    db.close();
    expect(count.n).toBe(0);
  }, 120000);
});

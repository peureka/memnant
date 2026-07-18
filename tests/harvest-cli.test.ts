/**
 * Integration tests for `memnant harvest --project-root` and MCP
 * session_context auto-harvest respecting the watermark.
 *
 * These spawn the compiled CLI / MCP server as child processes, so they run
 * against dist/ (build before running). HOME is the per-worker fake home from
 * tests/setup-isolation.ts, and transcripts are seeded under that fake
 * ~/.claude/projects slug dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getTranscriptDir } from '../src/harvest/discover.js';
import { openDatabase } from '../src/ledger/database.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf-8', timeout: 180_000 });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

function seedTranscript(projectPath: string, name: string, entries: any[]): void {
  const dir = getTranscriptDir(projectPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('harvest --project-root', () => {
  let mainDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    mainDir = mkdtempSync(join(tmpdir(), 'memnant-harvest-main-'));
    worktreeDir = mkdtempSync(join(tmpdir(), 'memnant-harvest-wt-'));
    runMemnant(['init'], mainDir);
  });

  afterEach(() => {
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('reads transcripts from the given path but writes to the cwd project ledger', () => {
    // Transcript lives under the worktree's slug dir, not the main project's.
    seedTranscript(worktreeDir, 'agent-abc.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use GraphQL for the mobile API layer." }] } },
    ]);

    const result = runMemnant(['harvest', '--project-root', worktreeDir], mainDir);
    expect(result.status).toBe(0);
    const match = result.stdout.match(/(\d+) new records/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);

    // Records landed in the MAIN project's ledger.
    const db = openDatabase(join(mainDir, '.memnant', 'ledger.db'));
    const rows = db.all("SELECT content_text FROM record WHERE content_text LIKE '%GraphQL%'");
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('fails with a helpful error when --project-root does not exist', () => {
    const missing = join(worktreeDir, 'does-not-exist-xyz');
    const result = runMemnant(['harvest', '--project-root', missing], mainDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not exist');
  }, 60_000);
});

describe('harvest --transcript-dir', () => {
  let mainDir: string;
  let orphanDir: string;

  beforeEach(() => {
    mainDir = mkdtempSync(join(tmpdir(), 'memnant-harvest-td-main-'));
    // A raw transcript dir that is NOT a slug of any live project path —
    // simulates a Claude Code transcript dir outliving a deleted worktree.
    orphanDir = mkdtempSync(join(tmpdir(), 'memnant-orphan-transcripts-'));
    runMemnant(['init'], mainDir);
  });

  afterEach(() => {
    rmSync(mainDir, { recursive: true, force: true });
    rmSync(orphanDir, { recursive: true, force: true });
  });

  it('reads .jsonl from the given dir into the cwd ledger; watermark makes a second run a no-op', () => {
    writeFileSync(
      join(orphanDir, 'agent-orphan.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: "Let's use Kafka for the event stream." }] },
      }) + '\n',
    );

    const first = runMemnant(['harvest', '--transcript-dir', orphanDir], mainDir);
    expect(first.status).toBe(0);
    const match = first.stdout.match(/(\d+) new records/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);

    const db = openDatabase(join(mainDir, '.memnant', 'ledger.db'));
    const rows = db.all("SELECT content_text FROM record WHERE content_text LIKE '%Kafka%'");
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Second run: unchanged files skipped by the watermark → 0 new records.
    const second = runMemnant(['harvest', '--transcript-dir', orphanDir], mainDir);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/0 new records/);
  }, 180_000);

  it('fails helpfully when --transcript-dir does not exist', () => {
    const missing = join(orphanDir, 'gone');
    const result = runMemnant(['harvest', '--transcript-dir', missing], mainDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not exist');
  }, 60_000);

  it('rejects --transcript-dir together with --project-root', () => {
    const result = runMemnant(['harvest', '--transcript-dir', orphanDir, '--project-root', mainDir], mainDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toLowerCase()).toMatch(/cannot|both|together|mutually/);
  }, 60_000);
});

describe('MCP session_context auto-harvest respects the watermark', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'memnant-harvest-mcp-'));
    runMemnant(['init'], projectDir);
    // The serve subprocess derives its projectRoot from the realpath'd cwd
    // (macOS /var -> /private/var). Seed the transcript under that same slug.
    seedTranscript(realpathSync(projectDir), 'agent-abc.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use GraphQL for the mobile API layer." }] } },
    ]);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('harvests once and does not re-harvest on the second call', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_PATH, 'serve'],
      cwd: projectDir,
    });
    const client = new Client({ name: 'memnant-test', version: '0.1.0' });
    await client.connect(transport);

    await client.callTool({ name: 'memnant_session_context', arguments: {} });
    await client.callTool({ name: 'memnant_session_context', arguments: {} });

    await client.close();
    await transport.close();

    // Server is down; safe to open the ledger. The harvested decision must
    // appear exactly once despite two auto-harvest passes.
    const db = openDatabase(join(projectDir, '.memnant', 'ledger.db'));
    const rows = db.all("SELECT content_text FROM record WHERE content_text LIKE '%GraphQL%'");
    db.close();
    expect(rows.length).toBe(1);
  }, 180_000);
});

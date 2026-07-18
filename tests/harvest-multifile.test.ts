/**
 * Multi-file transcript harvest, watermark sidecar, and array-content parsing.
 *
 * These exercise harvest() end-to-end in-process. Embeddings are mocked with
 * a deterministic bag-of-words generator plus a call counter, so we can assert
 * that unchanged transcripts trigger zero embedding work.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const embedCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return {
    ...actual,
    generateEmbedding: async (text: string) => {
      embedCalls.count++;
      return mockGenerateEmbedding(text);
    },
  };
});

import { harvest } from '../src/harvest/harvest.js';
import { getTranscriptDir } from '../src/harvest/discover.js';
import { createDatabase } from '../src/ledger/database.js';

let testDir: string;
let projectRoot: string;
let transcriptDir: string;
let db: any;
const projectId = 'proj-multifile';

function seed(name: string, entries: any[], mtimeMs?: number): string {
  const p = join(transcriptDir, name);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (mtimeMs !== undefined) {
    utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  }
  return p;
}

function recordTexts(): string[] {
  return db
    .all('SELECT content_text FROM record ORDER BY rowid')
    .map((r: any) => r.content_text);
}

beforeEach(() => {
  embedCalls.count = 0;
  testDir = join(tmpdir(), 'memnant-harvest-mf-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  projectRoot = join(testDir, 'my-project');
  mkdirSync(join(projectRoot, '.memnant'), { recursive: true });
  transcriptDir = getTranscriptDir(projectRoot);
  mkdirSync(transcriptDir, { recursive: true });
  db = createDatabase(join(projectRoot, '.memnant', 'ledger.db'));
  db.run(
    'INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
    [projectId, 'My Project', projectRoot, new Date().toISOString()],
  );
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(testDir, { recursive: true, force: true });
});

describe('multi-file harvest', () => {
  it('picks up candidates from an agent-*.jsonl file', async () => {
    // agent file (older) carries the decision; newer main file has none.
    // Current single-file harvest would read only the newest (main) and miss it.
    seed('agent-abc123.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use GraphQL for the mobile API layer." }] } },
    ], Date.now() - 20000);

    seed('main-session.jsonl', [
      { type: 'user', message: { role: 'user', content: "How's the project going?" } },
    ], Date.now() - 10000);

    const result = await harvest(db, projectRoot, projectId);

    expect(result.recordsWritten).toBeGreaterThanOrEqual(1);
    expect(recordTexts().some((t) => t.includes('GraphQL'))).toBe(true);
  });

  it('combines candidates from all files, processed in mtime order', async () => {
    seed('agent-oldest.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use GraphQL for the mobile querying surface." }] } },
    ], Date.now() - 30000);

    seed('session-middle.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's choose Rust for the ingestion worker binary." }] } },
    ], Date.now() - 20000);

    seed('agent-newest.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's pick Terraform for cloud infrastructure provisioning." }] } },
    ], Date.now() - 10000);

    const result = await harvest(db, projectRoot, projectId);

    const texts = recordTexts();
    expect(result.recordsWritten).toBe(3);
    expect(texts.some((t) => t.includes('GraphQL'))).toBe(true);
    expect(texts.some((t) => t.includes('Rust'))).toBe(true);
    expect(texts.some((t) => t.includes('Terraform'))).toBe(true);

    // Insertion order (rowid) follows mtime order: oldest -> newest.
    const graphqlIdx = texts.findIndex((t) => t.includes('GraphQL'));
    const rustIdx = texts.findIndex((t) => t.includes('Rust'));
    const terraformIdx = texts.findIndex((t) => t.includes('Terraform'));
    expect(graphqlIdx).toBeLessThan(rustIdx);
    expect(rustIdx).toBeLessThan(terraformIdx);
  });
});

describe('watermark', () => {
  it('second consecutive run does zero work on unchanged files', async () => {
    seed('agent-abc.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use GraphQL for the mobile API layer." }] } },
    ], Date.now() - 10000);

    const first = await harvest(db, projectRoot, projectId);
    expect(first.recordsWritten).toBeGreaterThanOrEqual(1);
    const countAfterFirst = db.get('SELECT COUNT(*) AS n FROM record').n;

    const statePath = join(projectRoot, '.memnant', 'harvest-state.json');
    expect(() => readFileSync(statePath, 'utf-8')).not.toThrow();

    embedCalls.count = 0;
    const second = await harvest(db, projectRoot, projectId);

    expect(second.candidatesExtracted).toBe(0);
    expect(second.recordsWritten).toBe(0);
    expect(embedCalls.count).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM record').n).toBe(countAfterFirst);
  });

  it('parses only appended content when a file grows between runs', async () => {
    const p = seed('session-live.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use SQLite for local single-file persistence." }] } },
    ], Date.now() - 20000);

    const first = await harvest(db, projectRoot, projectId);
    expect(first.recordsWritten).toBe(1);

    // Append a new decision line and advance mtime.
    appendFileSync(p, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: "Let's go with Kubernetes for container orchestration." }] },
    }) + '\n');
    utimesSync(p, new Date(), new Date());

    const second = await harvest(db, projectRoot, projectId);

    expect(second.candidatesExtracted).toBe(1);
    expect(second.recordsWritten).toBe(1);

    const texts = recordTexts();
    expect(texts.filter((t) => t.includes('SQLite'))).toHaveLength(1);
    expect(texts.some((t) => t.includes('Kubernetes'))).toBe(true);
    expect(texts).toHaveLength(2);
  });

  it('treats a corrupt state file as no watermark and rewrites it', async () => {
    const statePath = join(projectRoot, '.memnant', 'harvest-state.json');
    writeFileSync(statePath, '{ this is not valid json ]]');

    seed('agent-abc.jsonl', [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Let's use GraphQL for the mobile API layer." }] } },
    ], Date.now() - 10000);

    let result: any;
    await expect((async () => { result = await harvest(db, projectRoot, projectId); })()).resolves.not.toThrow();

    expect(result.recordsWritten).toBeGreaterThanOrEqual(1);
    // State rewritten to valid JSON.
    const rewritten = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(typeof rewritten).toBe('object');
    expect(Object.keys(rewritten).length).toBeGreaterThanOrEqual(1);
  });
});

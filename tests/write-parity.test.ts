/**
 * Write-path integrity parity — once a candidate record is accepted for
 * writing, its source must not determine the integrity processing it
 * receives (relationships, supersession, contradiction detection).
 *
 * Covers the shared writeCandidate primitive directly, then proves harvest
 * and interchange import produce equivalent ledger semantics for equivalent
 * input, and that observe gained the same processing.
 *
 * Similarity fixtures are empirically measured with the real MiniLM model
 * (deterministic): pairs are chosen inside the related window (>=0.75, <0.90
 * dedupe) or the contradiction window (>=0.75, <0.85).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding } from '../src/vector/embeddings.js';
import { serializeEmbedding } from '../src/vector/embedding-utils.js';
import { writeCandidate } from '../src/ledger/write.js';
import { harvest } from '../src/harvest/harvest.js';
import { importInterchange } from '../src/harvest/import.js';
import { parseInterchange, type Interchange } from '../src/harvest/interchange.js';
import { observeText } from '../src/observe/observe.js';

const PROJECT_ID = 'parity-test-project';

// Measured 0.878 vs EXISTING — related window (>=0.75, below 0.90 dedupe).
const EXISTING = 'Chose Redis for caching hot API responses with a short TTL';
const RELATED_TEXT = 'Use Redis to cache API responses with a five minute TTL';

// Measured 0.771 vs EXISTING — related window, and matches the rule-based
// "Decision:" extraction pattern so it survives harvest/observe extraction.
const RELATED_DECISION_MSG = 'Decision: use Redis to cache API responses with a five-minute expiry window';

// Measured 0.768 vs EXISTING — contradiction window (>=0.75, <0.85), and
// matches the "Decision:" extraction pattern.
const CONTRADICTING_DECISION_MSG = 'Decision: do not use Redis caching for API responses; serve every request fresh';

const TRIAGE_CONFIG = {
  project: { name: 'parity', id: PROJECT_ID },
  orchestrator: { tiers: { triage: { provider: 'anthropic', model: 'test-model', max_context_tokens: 2000 } } },
} as any;

const yesModel = async () => ({ text: 'yes' });
const noKeyModel = async () => {
  throw new Error('No API key configured');
};

function makeLedger(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const db = createDatabase(join(dir, 'ledger.db'));
  db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)", [
    PROJECT_ID,
    dir,
    new Date().toISOString(),
  ]);
  return db;
}

async function seedExisting(db: Database): Promise<string> {
  const record = insertRecord(db, {
    projectId: PROJECT_ID,
    type: 'decision',
    contentText: EXISTING,
    embedding: serializeEmbedding(await generateEmbedding(EXISTING)),
    tags: [],
  });
  return record.id;
}

function relationshipsFor(db: Database, recordId: string): Array<{ type: string; source_record_id: string; target_record_id: string }> {
  return db.all(
    'SELECT type, source_record_id, target_record_id FROM record_relationship WHERE source_record_id = ? OR target_record_id = ?',
    [recordId, recordId],
  ) as any;
}

function seedTranscript(dir: string, name: string, texts: string[]): void {
  mkdirSync(dir, { recursive: true });
  const lines = texts.map((text) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  );
  writeFileSync(join(dir, name), lines.join('\n') + '\n');
}

describe('writeCandidate — the shared integrity primitive', () => {
  const testDir = join(tmpdir(), 'memnant-write-parity-unit-' + Date.now());
  let db: Database;

  beforeEach(() => {
    db = makeLedger(testDir);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('writes the record and links it to related existing records', async () => {
    const existingId = await seedExisting(db);

    const { record, relationships } = await writeCandidate(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: RELATED_TEXT,
      tags: [],
    });

    expect(record.id).toBeTruthy();
    expect(relationships.length).toBeGreaterThan(0);
    const rels = relationshipsFor(db, record.id);
    expect(rels.some((r) => r.source_record_id === existingId || r.target_record_id === existingId)).toBe(true);
  }, 60000);

  it('detects contradictions when a triage model is available', async () => {
    await seedExisting(db);

    const { record, contradictions } = await writeCandidate(
      db,
      { projectId: PROJECT_ID, type: 'decision', contentText: CONTRADICTING_DECISION_MSG, tags: [] },
      { config: TRIAGE_CONFIG, callModelFn: yesModel },
    );

    expect(contradictions.length).toBeGreaterThan(0);
    const rels = relationshipsFor(db, record.id);
    expect(rels.some((r) => r.type === 'contradicts')).toBe(true);
  }, 60000);

  it('still writes the record when the model call fails (offline)', async () => {
    await seedExisting(db);

    const { record } = await writeCandidate(
      db,
      { projectId: PROJECT_ID, type: 'decision', contentText: CONTRADICTING_DECISION_MSG, tags: [] },
      { config: TRIAGE_CONFIG, callModelFn: noKeyModel },
    );

    const row = db.get('SELECT id FROM record WHERE id = ?', [record.id]);
    expect(row).toBeTruthy();
    const rels = relationshipsFor(db, record.id);
    expect(rels.some((r) => r.type === 'contradicts')).toBe(false);
    // Auto-linking is not model-dependent and must still have happened.
    expect(rels.length).toBeGreaterThan(0);
  }, 60000);

  it('preserves provenance passthrough in the content JSON', async () => {
    const { record } = await writeCandidate(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Chose Playwright over Cypress for end-to-end tests.',
      tags: ['imported'],
      origin: { provider: 'chatgpt', title: 'Testing stack' },
    });

    const row = db.get('SELECT content FROM record WHERE id = ?', [record.id]) as any;
    expect(JSON.parse(row.content).origin).toEqual({ provider: 'chatgpt', title: 'Testing stack' });
  }, 60000);

  it('accepts a precomputed embedding without regenerating', async () => {
    const embedding = serializeEmbedding(await generateEmbedding(RELATED_TEXT));
    const { record } = await writeCandidate(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: RELATED_TEXT,
      tags: [],
      embedding,
    });

    const row = db.get('SELECT embedding FROM record WHERE id = ?', [record.id]) as any;
    expect(row.embedding).toBeTruthy();
  }, 60000);
});

describe('harvest parity — transcripts get the same integrity as imports', () => {
  const testDir = join(tmpdir(), 'memnant-write-parity-harvest-' + Date.now());
  const projectRoot = join(testDir, 'project');
  const transcriptDir = join(testDir, 'transcripts');
  let db: Database;

  beforeEach(() => {
    mkdirSync(join(projectRoot, '.memnant'), { recursive: true });
    db = makeLedger(projectRoot);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('a harvested decision links to related existing knowledge', async () => {
    const existingId = await seedExisting(db);
    seedTranscript(transcriptDir, 'session.jsonl', [RELATED_DECISION_MSG]);

    const result = await harvest(db, projectRoot, PROJECT_ID, { transcriptDir, config: TRIAGE_CONFIG });
    expect(result.recordsWritten).toBe(1);

    const rels = relationshipsFor(db, existingId);
    expect(rels.length).toBeGreaterThan(0);
  }, 60000);

  it('a harvested contradiction is flagged like an imported one', async () => {
    const existingId = await seedExisting(db);
    seedTranscript(transcriptDir, 'session.jsonl', [CONTRADICTING_DECISION_MSG]);

    const result = await harvest(db, projectRoot, PROJECT_ID, {
      transcriptDir,
      config: TRIAGE_CONFIG,
      callModelFn: yesModel,
    });
    expect(result.recordsWritten).toBe(1);

    const rels = relationshipsFor(db, existingId);
    expect(rels.some((r) => r.type === 'contradicts')).toBe(true);
  }, 60000);
});

describe('equivalent input, equivalent ledger semantics', () => {
  const testDir = join(tmpdir(), 'memnant-write-parity-equiv-' + Date.now());
  const harvestRoot = join(testDir, 'via-harvest');
  const importRoot = join(testDir, 'via-import');
  const transcriptDir = join(testDir, 'transcripts');

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function conversation(text: string): Interchange {
    const parsed = parseInterchange({
      memnant_interchange: 1,
      source: { provider: 'chatgpt' },
      messages: [{ role: 'assistant', text }],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.value;
  }

  it('harvest and import of the same message produce equivalent records', async () => {
    // Ledger X: the message arrives via a Claude Code transcript.
    mkdirSync(join(harvestRoot, '.memnant'), { recursive: true });
    const dbX = makeLedger(harvestRoot);
    await seedExisting(dbX);
    seedTranscript(transcriptDir, 'session.jsonl', [CONTRADICTING_DECISION_MSG]);
    await harvest(dbX, harvestRoot, PROJECT_ID, {
      transcriptDir,
      config: TRIAGE_CONFIG,
      callModelFn: yesModel,
    });

    // Ledger Y: the identical message arrives via interchange import.
    const dbY = makeLedger(importRoot);
    await seedExisting(dbY);
    await importInterchange(dbY, PROJECT_ID, conversation(CONTRADICTING_DECISION_MSG), {
      config: TRIAGE_CONFIG,
      callModelFn: yesModel,
    });

    const rowX = dbX.get(
      "SELECT type, content_text, tags FROM record WHERE content_text != ?",
      [EXISTING],
    ) as any;
    const rowY = dbY.get(
      "SELECT type, content_text, tags FROM record WHERE content_text != ?",
      [EXISTING],
    ) as any;

    // Same type and content.
    expect(rowX.type).toBe(rowY.type);
    expect(rowX.content_text).toBe(rowY.content_text);

    // Same tags once expected provenance tags are excluded.
    const provenanceTags = new Set(['imported', 'from:chatgpt']);
    const tagsX = JSON.parse(rowX.tags).filter((t: string) => !provenanceTags.has(t)).sort();
    const tagsY = JSON.parse(rowY.tags).filter((t: string) => !provenanceTags.has(t)).sort();
    expect(tagsX).toEqual(tagsY);

    // Same relationship semantics.
    const relTypes = (db: Database) =>
      (db.all('SELECT type FROM record_relationship ORDER BY type') as any[]).map((r) => r.type);
    expect(relTypes(dbX)).toEqual(relTypes(dbY));
    expect(relTypes(dbX)).toContain('contradicts');

    dbX.close();
    dbY.close();
  }, 90000);
});

describe('observe parity', () => {
  const testDir = join(tmpdir(), 'memnant-write-parity-observe-' + Date.now());
  let db: Database;

  beforeEach(() => {
    db = makeLedger(testDir);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('observed decisions receive relationship processing', async () => {
    const existingId = await seedExisting(db);

    const result = await observeText(db, RELATED_DECISION_MSG, PROJECT_ID, { config: TRIAGE_CONFIG });
    expect(result.recordsWritten).toBe(1);

    const rels = relationshipsFor(db, existingId);
    expect(rels.length).toBeGreaterThan(0);
  }, 60000);
});

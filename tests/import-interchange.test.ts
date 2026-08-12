/**
 * Import pipeline tests — interchange file → extraction → dedupe → ledger,
 * with provenance preserved.
 *
 * These run the real pipeline (real embeddings, no LLM configured), so
 * extraction exercises the rule-based fallback — the same behaviour a user
 * gets offline with no API key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding } from '../src/vector/embeddings.js';
import { serializeEmbedding } from '../src/vector/embedding-utils.js';
import { parseInterchange, type Interchange } from '../src/harvest/interchange.js';
import { importInterchange } from '../src/harvest/import.js';

const PROJECT_ID = 'import-test-project';

function mustParse(data: unknown): Interchange {
  const result = parseInterchange(data);
  if (!result.ok) throw new Error(`fixture invalid: ${result.errors.join('; ')}`);
  return result.value;
}

/** A realistic ChatGPT product conversation: proposal → discussion → explicit decision + rejection. */
function chatgptPricingConversation(): Interchange {
  return mustParse({
    memnant_interchange: 1,
    source: {
      provider: 'chatgpt',
      conversation_id: 'c-7f3a',
      title: 'Pricing model for the metering API',
      url: 'https://chatgpt.com/c/c-7f3a',
      exported_at: '2026-08-10T14:00:00Z',
    },
    messages: [
      { role: 'user', text: 'We need to settle pricing for the metering API before the launch page goes up. Options on the table: per-seat, usage-based, or a flat platform fee.' },
      { role: 'assistant', text: 'A few considerations. Per-seat is predictable but penalises collaborative teams. Usage-based aligns cost with the value of an API product. Flat fee is simplest but leaves money on the table at the top end. What does your cost structure look like?' },
      { role: 'user', text: 'Costs scale almost linearly with request volume. Support load is flat.' },
      { role: 'assistant', text: 'Then usage-based pricing matches your marginal costs. You could add a small platform fee as a floor so tiny accounts still cover support.' },
      { role: 'user', text: "Let's go with usage-based pricing with a monthly platform fee floor. Per-seat is out — it punishes exactly the teams we want as advocates." },
      { role: 'assistant', text: 'Agreed. Usage-based with a platform-fee floor it is. I can draft the pricing page copy next.' },
    ],
  });
}

describe('importInterchange — conversations', () => {
  const testDir = join(tmpdir(), 'memnant-import-interchange-' + Date.now());
  let db: Database;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = createDatabase(join(testDir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)", [
      PROJECT_ID,
      testDir,
      new Date().toISOString(),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('imports an explicit user decision with full provenance', async () => {
    const result = await importInterchange(db, PROJECT_ID, chatgptPricingConversation());

    expect(result.kind).toBe('conversation');
    expect(result.provider).toBe('chatgpt');
    expect(result.messagesRead).toBe(6);
    expect(result.recordsWritten).toBeGreaterThanOrEqual(1);

    const rows = db.all(
      "SELECT type, content, content_text, tags, embedding FROM record WHERE type = 'decision'",
    ) as unknown as Array<{ type: string; content: string; content_text: string; tags: string; embedding: Uint8Array }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const decision = rows.find((r) => r.content_text.includes('usage-based'));
    expect(decision).toBeDefined();

    // Provenance: filterable tags + structured origin in the content JSON.
    const tags = JSON.parse(decision!.tags);
    expect(tags).toContain('imported');
    expect(tags).toContain('from:chatgpt');

    const content = JSON.parse(decision!.content);
    expect(content.origin).toEqual({
      provider: 'chatgpt',
      conversation_id: 'c-7f3a',
      title: 'Pricing model for the metering API',
      url: 'https://chatgpt.com/c/c-7f3a',
      exported_at: '2026-08-10T14:00:00Z',
    });

    // Imported records are first-class: embedded like any other record.
    expect(decision!.embedding).toBeTruthy();
  }, 60000);

  it('does not import an assistant recommendation the user never accepted', async () => {
    const conversation = mustParse({
      memnant_interchange: 1,
      source: { provider: 'chatgpt' },
      messages: [
        { role: 'user', text: 'What billing provider would suit a usage-metered SaaS?' },
        { role: 'assistant', text: 'I recommend Stripe Billing here. It handles metered usage and proration well, and the dashboard covers most admin needs.' },
        { role: 'user', text: 'Interesting. I want to compare a couple of alternatives before committing.' },
      ],
    });

    const result = await importInterchange(db, PROJECT_ID, conversation);
    expect(result.recordsWritten).toBe(0);

    const count = db.get('SELECT COUNT(*) as n FROM record') as unknown as { n: number };
    expect(count.n).toBe(0);
  }, 60000);

  it('imports a rejected approach tagged as rejected', async () => {
    const conversation = mustParse({
      memnant_interchange: 1,
      source: { provider: 'claude' },
      messages: [
        { role: 'user', text: 'Why did sessions keep dropping on the staging box?' },
        { role: 'assistant', text: 'I tried using Redis for session storage but it kept losing data on restart. Switched to Postgres-backed sessions instead.' },
      ],
    });

    const result = await importInterchange(db, PROJECT_ID, conversation);
    expect(result.recordsWritten).toBeGreaterThanOrEqual(1);

    const rows = db.all('SELECT tags FROM record') as unknown as Array<{ tags: string }>;
    const rejected = rows.filter((r) => JSON.parse(r.tags).includes('rejected'));
    expect(rejected.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('imports multiple decisions from one conversation', async () => {
    const conversation = mustParse({
      memnant_interchange: 1,
      source: { provider: 'copilot', title: 'Stack choices' },
      messages: [
        { role: 'user', text: "Let's go with Fastify for the gateway service." },
        { role: 'assistant', text: 'Fastify works well for that: schema validation is built in and the plugin system keeps middleware tidy.' },
        { role: 'user', text: "And let's use BullMQ for the background job queue." },
        { role: 'assistant', text: 'BullMQ on the existing Redis instance keeps the operational surface small.' },
      ],
    });

    const result = await importInterchange(db, PROJECT_ID, conversation);
    expect(result.recordsWritten).toBeGreaterThanOrEqual(2);

    const rows = db.all('SELECT content_text, tags FROM record') as unknown as Array<{ content_text: string; tags: string }>;
    const texts = rows.map((r) => r.content_text).join(' ');
    expect(texts).toContain('Fastify');
    expect(texts).toContain('BullMQ');

    // Provider-neutral provenance for a non-flagship source.
    expect(JSON.parse(rows[0].tags)).toContain('from:copilot');
  }, 60000);

  it('skips decisions that already exist in the ledger', async () => {
    const existing = 'Chose Postgres for the analytics DB.';
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: existing,
      embedding: serializeEmbedding(await generateEmbedding(existing)),
      tags: [],
    });

    const conversation = mustParse({
      memnant_interchange: 1,
      source: { provider: 'chatgpt' },
      messages: [
        { role: 'user', text: 'Remind me — what did we settle on for analytics storage?' },
        { role: 'assistant', text: 'Chose Postgres for the analytics DB.' },
      ],
    });

    const result = await importInterchange(db, PROJECT_ID, conversation);
    expect(result.duplicatesSkipped).toBeGreaterThanOrEqual(1);
    expect(result.recordsWritten).toBe(0);
  }, 60000);

  it('handles an empty conversation', async () => {
    const conversation = mustParse({
      memnant_interchange: 1,
      source: { provider: 'chatgpt' },
      messages: [],
    });

    const result = await importInterchange(db, PROJECT_ID, conversation);
    expect(result).toMatchObject({
      messagesRead: 0,
      candidates: 0,
      recordsWritten: 0,
      duplicatesSkipped: 0,
    });
  }, 60000);

  it('works with no LLM configured (rule-based extraction path)', async () => {
    // No tierConfig passed anywhere in this suite — this test just makes the
    // offline guarantee explicit.
    const result = await importInterchange(db, PROJECT_ID, chatgptPricingConversation(), {
      tierConfig: null,
    });
    expect(result.recordsWritten).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe('importInterchange — pre-extracted records', () => {
  const testDir = join(tmpdir(), 'memnant-import-records-' + Date.now());
  let db: Database;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = createDatabase(join(testDir, 'ledger.db'));
    db.run("INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)", [
      PROJECT_ID,
      testDir,
      new Date().toISOString(),
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function recordsBundle(): Interchange {
    return mustParse({
      memnant_interchange: 1,
      source: {
        provider: 'claude',
        title: 'Metering API architecture',
        exported_at: '2026-08-11T09:30:00Z',
      },
      records: [
        {
          type: 'decision',
          content: 'Chose usage-based pricing with a monthly platform-fee floor for the metering API; per-seat pricing was rejected because it penalises collaborative teams.',
          tags: ['pricing'],
        },
        {
          type: 'framework_fix',
          content: 'Stripe metered billing: usage records must be reported with an idempotency key per window, otherwise retries double-count usage.',
          tags: ['stripe'],
        },
      ],
    });
  }

  it('writes validated records with provenance, embeddings, and type preserved', async () => {
    const result = await importInterchange(db, PROJECT_ID, recordsBundle());

    expect(result.kind).toBe('records');
    expect(result.candidates).toBe(2);
    expect(result.recordsWritten).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);

    const rows = db.all('SELECT type, content, tags, embedding FROM record ORDER BY type') as unknown as Array<{
      type: string;
      content: string;
      tags: string;
      embedding: Uint8Array;
    }>;
    expect(rows.map((r) => r.type)).toEqual(['decision', 'framework_fix']);

    for (const row of rows) {
      const tags = JSON.parse(row.tags);
      expect(tags).toContain('imported');
      expect(tags).toContain('from:claude');
      const content = JSON.parse(row.content);
      expect(content.origin.provider).toBe('claude');
      expect(content.origin.title).toBe('Metering API architecture');
      expect(row.embedding).toBeTruthy();
    }

    const decisionTags = JSON.parse(rows[0].tags);
    expect(decisionTags).toContain('pricing');
  }, 60000);

  it('deduplicates a re-imported bundle against the ledger', async () => {
    await importInterchange(db, PROJECT_ID, recordsBundle());
    const second = await importInterchange(db, PROJECT_ID, recordsBundle());

    expect(second.recordsWritten).toBe(0);
    expect(second.duplicatesSkipped).toBe(2);

    const count = db.get('SELECT COUNT(*) as n FROM record') as unknown as { n: number };
    expect(count.n).toBe(2);
  }, 60000);

  it('auto-links imported records to related existing knowledge', async () => {
    // Pair measured at ~0.88 cosine with the real model: related (>=0.75)
    // but below the 0.90 dedupe threshold.
    const existing = 'Chose Redis for caching hot API responses with a short TTL';
    const r1 = insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: existing,
      embedding: serializeEmbedding(await generateEmbedding(existing)),
      tags: [],
    });

    const bundle = mustParse({
      memnant_interchange: 1,
      source: { provider: 'chatgpt' },
      records: [
        { type: 'decision', content: 'Use Redis to cache API responses with a five minute TTL' },
      ],
    });

    const result = await importInterchange(db, PROJECT_ID, bundle);
    expect(result.recordsWritten).toBe(1);

    const rels = db.all(
      'SELECT type FROM record_relationship WHERE source_record_id = ? OR target_record_id = ?',
      [r1.id, r1.id],
    ) as unknown as Array<{ type: string }>;
    expect(rels.length).toBeGreaterThan(0);
  }, 60000);

  it('dry run reports without writing', async () => {
    const result = await importInterchange(db, PROJECT_ID, recordsBundle(), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.recordsWritten).toBe(2);

    const count = db.get('SELECT COUNT(*) as n FROM record') as unknown as { n: number };
    expect(count.n).toBe(0);
  }, 60000);

  it('result lists the records so a dry run can be reviewed', async () => {
    const dry = await importInterchange(db, PROJECT_ID, recordsBundle(), { dryRun: true });
    expect(dry.records).toHaveLength(2);
    expect(dry.records.map((r) => r.type).sort()).toEqual(['decision', 'framework_fix']);
    expect(dry.records.find((r) => r.type === 'decision')?.content).toContain('usage-based pricing');
    expect(dry.records.find((r) => r.type === 'decision')?.tags).toContain('pricing');

    // Real writes list the same records (what actually landed).
    const real = await importInterchange(db, PROJECT_ID, recordsBundle());
    expect(real.records).toHaveLength(2);
  }, 60000);
});

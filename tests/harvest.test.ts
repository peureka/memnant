import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findTranscripts, findLatestTranscript } from '../src/harvest/discover.js';
import { parseTranscript } from '../src/harvest/parser.js';
import { extractKnowledge } from '../src/harvest/extract.js';
import { buildExtractionPrompt, parseExtractionResponse } from '../src/harvest/extract-llm.js';
import { deduplicateAgainstLedger } from '../src/harvest/harvest.js';
import { createDatabase } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding } from '../src/vector/embeddings.js';
import { serializeEmbedding } from '../src/vector/embedding-utils.js';

describe('transcript discovery', () => {
  const testDir = join(tmpdir(), 'memnant-harvest-test-' + Date.now());
  const projectDir = join(testDir, 'test-project');

  beforeEach(() => {
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('finds JSONL transcript files in a project directory', () => {
    writeFileSync(join(projectDir, 'abc-123.jsonl'), '{}');
    writeFileSync(join(projectDir, 'def-456.jsonl'), '{}');
    mkdirSync(join(projectDir, 'abc-123'));

    const transcripts = findTranscripts(projectDir);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toMatch(/\.jsonl$/);
  });

  it('returns empty array when no transcripts exist', () => {
    const transcripts = findTranscripts(projectDir);
    expect(transcripts).toEqual([]);
  });

  it('findLatestTranscript returns most recently modified', () => {
    const older = join(projectDir, 'old.jsonl');
    const newer = join(projectDir, 'new.jsonl');
    writeFileSync(older, '{}');
    const now = new Date();
    writeFileSync(newer, '{}');
    utimesSync(older, new Date(now.getTime() - 10000), new Date(now.getTime() - 10000));

    const latest = findLatestTranscript(projectDir);
    expect(latest).toBe(newer);
  });

  it('findLatestTranscript returns null when empty', () => {
    const latest = findLatestTranscript(projectDir);
    expect(latest).toBeNull();
  });
});

describe('transcript parser', () => {
  const testDir = join(tmpdir(), 'memnant-harvest-parse-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts user and assistant text messages', async () => {
    const transcript = join(testDir, 'test.jsonl');
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Use Postgres for the analytics DB' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Good choice. Postgres over MySQL because...' }] } }),
      JSON.stringify({ type: 'progress', message: null }),
    ];
    writeFileSync(transcript, lines.join('\n'));

    const messages = await parseTranscript(transcript);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].text).toContain('Postgres');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].text).toContain('Postgres over MySQL');
  });

  it('handles tool_use content blocks by extracting text blocks only', async () => {
    const transcript = join(testDir, 'test2.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/foo' } },
            { type: 'text', text: 'After reading the file, I decided to use Redis.' },
          ],
        },
      }),
    ];
    writeFileSync(transcript, lines.join('\n'));

    const messages = await parseTranscript(transcript);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain('Redis');
    expect(messages[0].text).not.toContain('Read');
  });

  it('skips thinking blocks', async () => {
    const transcript = join(testDir, 'test3.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal reasoning...' },
            { type: 'text', text: 'The visible response.' },
          ],
        },
      }),
    ];
    writeFileSync(transcript, lines.join('\n'));

    const messages = await parseTranscript(transcript);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).not.toContain('internal reasoning');
    expect(messages[0].text).toContain('visible response');
  });
});

describe('rule-based extraction', () => {
  it('extracts decisions from "let\'s go with X" patterns', () => {
    const messages = [
      { role: 'user' as const, text: "Let's go with Postgres for the analytics database" },
      { role: 'assistant' as const, text: "Good choice. Postgres gives us better JSON support and window functions for analytics queries." },
    ];

    const records = extractKnowledge(messages);
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0].type).toBe('decision');
    expect(records[0].content).toContain('Postgres');
  });

  it('extracts rejections from "tried X but" patterns', () => {
    const messages = [
      { role: 'assistant' as const, text: "I tried using Redis for session storage but it kept losing data on restart. Switched to Postgres-backed sessions instead." },
    ];

    const records = extractKnowledge(messages);
    const rejections = records.filter(r => r.tags.includes('rejected'));
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    expect(rejections[0].content).toContain('Redis');
  });

  it('extracts framework fixes from error-then-fix patterns', () => {
    const messages = [
      { role: 'assistant' as const, text: "The error was 'useSearchParams needs Suspense boundary'. Fixed by wrapping the component in a Suspense boundary. Verified it works." },
    ];

    const records = extractKnowledge(messages);
    const fixes = records.filter(r => r.type === 'framework_fix');
    expect(fixes.length).toBeGreaterThanOrEqual(1);
    expect(fixes[0].content).toContain('Suspense');
  });

  it('returns empty for small talk with no decisions', () => {
    const messages = [
      { role: 'user' as const, text: "How's the project going?" },
      { role: 'assistant' as const, text: "Everything looks good. Tests are passing." },
    ];

    const records = extractKnowledge(messages);
    expect(records).toEqual([]);
  });
});

describe('LLM extraction', () => {
  it('builds a prompt from messages', () => {
    const messages = [
      { role: 'user' as const, text: "Let's use Tailwind" },
      { role: 'assistant' as const, text: 'Tailwind over CSS modules for utility-first.' },
    ];

    const prompt = buildExtractionPrompt(messages);
    expect(prompt).toContain('Tailwind');
    expect(prompt).toContain('Extract');
  });

  it('parses a JSON extraction response', () => {
    const response = JSON.stringify([
      { type: 'decision', content: 'Chose Tailwind over CSS modules', tags: ['css', 'architecture'] },
    ]);

    const records = parseExtractionResponse(response);
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe('decision');
    expect(records[0].content).toContain('Tailwind');
  });

  it('returns empty on malformed response', () => {
    const records = parseExtractionResponse('not json at all');
    expect(records).toEqual([]);
  });

  it('filters out invalid record types', () => {
    const response = JSON.stringify([
      { type: 'decision', content: 'Valid', tags: [] },
      { type: 'note', content: 'Invalid type', tags: [] },
    ]);

    const records = parseExtractionResponse(response);
    expect(records).toHaveLength(1);
  });
});

describe('harvest deduplication', () => {
  const testDir = join(tmpdir(), 'memnant-harvest-dedup-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('filters out records that already exist in ledger', async () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test-project', 'Test', '/tmp/test', new Date().toISOString()]
    );

    // Insert existing record
    const embedding = await generateEmbedding('Chose Postgres for analytics database');
    const embeddingBuffer = serializeEmbedding(embedding);
    insertRecord(db, {
      projectId: 'test-project',
      type: 'decision',
      contentText: 'Chose Postgres for analytics database',
      embedding: embeddingBuffer,
      tags: ['postgres'],
    });

    const candidates = [
      { type: 'decision' as const, content: 'Chose Postgres for the analytics DB', tags: ['postgres'] },
      { type: 'decision' as const, content: 'Use Redis for caching layer with 5min TTL', tags: ['redis'] },
    ];

    const unique = await deduplicateAgainstLedger(db, candidates, 0.90);
    expect(unique).toHaveLength(1);
    expect(unique[0].content).toContain('Redis');

    db.close();
  }, 30000);
});

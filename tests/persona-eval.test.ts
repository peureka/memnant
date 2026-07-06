/**
 * Tests for persona evaluation module.
 *
 * Tests parseEvalResponse, getPersonaQuestions, and evaluatePersonas.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { createSession } from '../src/ledger/sessions.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});
import { parseEvalResponse, getPersonaQuestions, evaluatePersonas } from '../src/governor/persona-eval.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';

function makeConfig(docsPath: string): ProjectConfig {
  return {
    project: { name: 'test', id: PROJECT_ID },
    memory: {
      db_path: '.memnant/ledger.db',
      export_path: '.memnant/export/',
      snapshot_interval: 'monthly',
      max_spec_snapshots: 5,
      max_codebase_snapshots: 3,
    },
    orchestrator: {
      tiers: {
        triage: { provider: 'anthropic', model: 'test' },
        analysis: { provider: 'anthropic', model: 'test' },
        build: { provider: 'anthropic', model: 'test' },
      },
      interfaces: {
        telegram: { enabled: false },
        cli: { enabled: true },
        mcp: { enabled: true, port: 3100 },
      },
    },
    governor: { docs_path: docsPath, lint_on_pr: false, strict_mode: false },
    security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
  } as ProjectConfig;
}

describe('Persona evaluation', () => {
  let testDir: string;
  let docsDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-persona-eval-'));
    docsDir = join(testDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  async function insertTestRecord(
    content: string,
    sessionId: string,
    type: string = 'decision',
  ) {
    const embedding = await generateEmbedding(content);
    const embeddingBuffer = serializeEmbedding(embedding);
    return insertRecord(db, {
      projectId: PROJECT_ID,
      type: type as 'decision',
      contentText: content,
      embedding: embeddingBuffer,
      sourceSession: sessionId,
    });
  }

  async function writePersonaDoc(filename: string, content: string) {
    await writeFile(join(docsDir, filename), content, 'utf-8');
  }

  describe('parseEvalResponse', () => {
    it('parses PASS with confidence and rationale', () => {
      const response = 'PASS 0.85\nThe session work directly addresses the persona need for quick context.';
      const result = parseEvalResponse(response);

      expect(result.result).toBe('PASS');
      expect(result.confidence).toBe(0.85);
      expect(result.rationale).toBe(
        'The session work directly addresses the persona need for quick context.',
      );
    });

    it('parses FAIL with confidence', () => {
      const response = 'FAIL 0.6\nThe feature exists but does not meet the performance threshold.';
      const result = parseEvalResponse(response);

      expect(result.result).toBe('FAIL');
      expect(result.confidence).toBe(0.6);
      expect(result.rationale).toContain('does not meet');
    });

    it('parses SKIP with confidence', () => {
      const response = 'SKIP 0.9\nThe session work is unrelated to this persona question.';
      const result = parseEvalResponse(response);

      expect(result.result).toBe('SKIP');
      expect(result.confidence).toBe(0.9);
      expect(result.rationale).toContain('unrelated');
    });

    it('returns SKIP with confidence 0 for malformed input', () => {
      const response = 'This is not a valid response format at all.';
      const result = parseEvalResponse(response);

      expect(result.result).toBe('SKIP');
      expect(result.confidence).toBe(0);
      expect(result.rationale).toContain('Failed to parse');
    });
  });

  describe('getPersonaQuestions', () => {
    it('extracts questions from persona doc with frontmatter type: persona', async () => {
      await writePersonaDoc(
        'PERSONA_KAI.md',
        `---
type: persona
---
Kai is a solo developer shipping a SaaS product.
He needs fast context recovery after time away.

## Test Questions

- Does the feature help Kai recover context in under 2 minutes?
- Would Kai skip this feature because it is one more thing to maintain?
`,
      );

      const questions = getPersonaQuestions(docsDir);

      expect(questions).toHaveLength(2);
      expect(questions[0].persona).toBe('KAI');
      expect(questions[0].question).toBe(
        'Does the feature help Kai recover context in under 2 minutes?',
      );
      expect(questions[0].personaContext).toContain('solo developer');
      expect(questions[1].question).toContain('skip this feature');
    });

    it('returns empty when no persona docs exist', async () => {
      // Write a non-persona doc
      await writePersonaDoc(
        'SPEC.md',
        `---
type: data_model
---
Some data model spec.
`,
      );

      const questions = getPersonaQuestions(docsDir);
      expect(questions).toHaveLength(0);
    });
  });

  describe('evaluatePersonas', () => {
    it('returns [] when no persona docs exist', async () => {
      const session = createSession(db, PROJECT_ID);
      await insertTestRecord('Decided to use React', session.id);

      const config = makeConfig(docsDir);
      const results = await evaluatePersonas(db, config, {
        sessionId: session.id,
        projectRoot: testDir,
      });

      expect(results).toEqual([]);
    });

    it('returns [] when session has no work records', async () => {
      await writePersonaDoc(
        'persona-kai.md',
        `---
type: persona
---
Kai is a solo developer.

## Test Questions

- Does this help Kai ship faster?
`,
      );

      const session = createSession(db, PROJECT_ID);
      // Insert only a session_log record — not a work record
      await insertTestRecord('Session started', session.id, 'session_log');

      const config = makeConfig(docsDir);
      const results = await evaluatePersonas(db, config, {
        sessionId: session.id,
        projectRoot: testDir,
      });

      expect(results).toEqual([]);
    });
  });
});

describe('CLI and MCP registration', () => {
  it('eval-persona command is imported in CLI index', () => {
    const indexCode = readFileSync('src/cli/index.ts', 'utf-8');
    expect(indexCode).toContain('registerEvalPersonaCommand');
  });

  it('memnant_eval_persona is registered in MCP server', () => {
    const serverCode = readFileSync('src/mcp/server.ts', 'utf-8');
    expect(serverCode).toContain('memnant_eval_persona');
  });

  it('session close handler calls evaluatePersonas', () => {
    const serverCode = readFileSync('src/mcp/server.ts', 'utf-8');
    const sessionCloseIdx = serverCode.indexOf('memnant_session_close');
    const afterSessionClose = serverCode.slice(sessionCloseIdx);
    expect(afterSessionClose).toContain('evaluatePersonas');
  });
});

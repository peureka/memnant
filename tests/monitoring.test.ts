/**
 * Tests for Epic 13: Proactive Monitoring.
 *
 * Story 13.1: Health summary.
 * Story 13.3: Spec drift detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, mkdirSync } from 'fs';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../src/vector/embeddings.js';

vi.mock('../src/vector/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/vector/embeddings.js')>();
  const { mockGenerateEmbedding } = await import('./helpers/mock-embeddings.js');
  return { ...actual, generateEmbedding: async (text: string) => mockGenerateEmbedding(text) };
});
import { gatherHealth, formatHealthReport, type HealthReport } from '../src/monitoring/health.js';
import { detectSpecDrift } from '../src/governor/drift.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';

function makeConfig(): ProjectConfig {
  return {
    project: { name: 'test-project', id: PROJECT_ID },
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
    governor: { docs_path: 'docs/', lint_on_pr: false, strict_mode: false },
    security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
  } as ProjectConfig;
}

describe('Story 13.1: Health summary', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-health-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test-project', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns healthy status for empty project', async () => {
    const config = makeConfig();
    const report = await gatherHealth(db, config, testDir);

    expect(report.status).toBe('healthy');
    expect(report.project_name).toBe('test-project');
    expect(report.record_count).toBe(0);
    expect(report.session_count).toBe(0);
  });

  it('stale_count reflects dynamically stale records, not the dead column', async () => {
    const config = makeConfig();
    // snapshot at left-pad ^1.0.0; package.json now ^2.0.0; a fix mentions left-pad -> live-stale
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: { 'left-pad': '^2.0.0' } }, null, 2),
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, created_at)
       VALUES (?, ?, 'codebase_snapshot', ?, 'snapshot', ?, ?)`,
      [
        'snap-1', PROJECT_ID,
        JSON.stringify({ files: [], dependencies: { 'left-pad': '^1.0.0' }, file_count: 0 }),
        serializeEmbedding(await generateEmbedding('snap')), new Date().toISOString(),
      ],
    );
    insertRecord(db, {
      projectId: PROJECT_ID, type: 'framework_fix',
      contentText: 'Pinned left-pad after the breaking 2.0 upgrade',
      embedding: serializeEmbedding(await generateEmbedding('left-pad')),
    });

    const report = await gatherHealth(db, config, testDir);
    expect(report.stale_count).toBe(1);
  });

  it('counts records correctly', async () => {
    const config = makeConfig();
    const embedding = await generateEmbedding('test');
    insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use PostgreSQL',
      embedding: serializeEmbedding(embedding),
    });

    const report = await gatherHealth(db, config, testDir);
    expect(report.record_count).toBe(1);
  });

  it('reports contradictions in issues', async () => {
    const config = makeConfig();

    const embedding1 = await generateEmbedding('Use PostgreSQL');
    const embedding2 = await generateEmbedding('Use MySQL');

    const rec1 = insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use PostgreSQL',
      embedding: serializeEmbedding(embedding1),
    });
    const rec2 = insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'decision',
      contentText: 'Use MySQL',
      embedding: serializeEmbedding(embedding2),
    });

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES (?, ?, ?, 'contradicts', 0.85, ?)`,
      ['rel-1', rec1.id, rec2.id, new Date().toISOString()],
    );

    const report = await gatherHealth(db, config, testDir);
    expect(report.unresolved_contradictions).toBe(1);
    expect(report.status).toBe('attention');
    expect(report.issues.some(i => i.includes('contradiction'))).toBe(true);
  });

  it('formats health report as text', () => {
    const report: HealthReport = {
      status: 'healthy',
      project_name: 'test-project',
      record_count: 10,
      session_count: 3,
      days_since_last_session: 2,
      days_since_last_snapshot: 1,
      unresolved_contradictions: 0,
      stale_count: 0,
      record_growth_7d: 5,
      issues: [],
    };

    const text = formatHealthReport(report);
    expect(text).toContain('[OK]');
    expect(text).toContain('test-project');
    expect(text).toContain('Records: 10');
    expect(text).toContain('Sessions: 3');
  });

  it('formats critical report with issues', () => {
    const report: HealthReport = {
      status: 'critical',
      project_name: 'broken',
      record_count: 50,
      session_count: 1,
      days_since_last_session: 45,
      days_since_last_snapshot: null,
      unresolved_contradictions: 3,
      stale_count: 10,
      record_growth_7d: 0,
      issues: ['10 stale records', 'No session in 45 days'],
    };

    const text = formatHealthReport(report);
    expect(text).toContain('[XX]');
    expect(text).toContain('Issues:');
    expect(text).toContain('10 stale records');
  });
});

describe('Story 13.3: Spec drift detection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-drift-'));
    mkdirSync(join(testDir, 'docs'), { recursive: true });
    mkdirSync(join(testDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns no violations when no specs exist', () => {
    writeFileSync(join(testDir, 'src', 'app.ts'), 'console.log("hello")');
    const result = detectSpecDrift(['src/app.ts'], testDir, join(testDir, 'docs'));
    expect(result.total_violations).toBe(0);
  });

  it('detects copy violations in changed files', () => {
    // Create copy audit spec
    const specContent = `---
type: copy_audit
applies_to: all
---

## Banned

- "utilize" → "use" — Plain English
`;
    writeFileSync(join(testDir, 'docs', 'COPY_AUDIT.md'), specContent);
    writeFileSync(join(testDir, 'src', 'readme.md'), 'We utilize this feature extensively.');

    const result = detectSpecDrift(['src/readme.md'], testDir, join(testDir, 'docs'));
    expect(result.total_violations).toBeGreaterThan(0);
    expect(result.copy_violations.length).toBe(1);
    expect(result.copy_violations[0].file).toBe('src/readme.md');
  });

  it('detects design violations in changed source files', () => {
    const specContent = `---
type: design_system
applies_to: all
---

## Banned Components

- "OldButton" → "Button" — Deprecated component
`;
    writeFileSync(join(testDir, 'docs', 'DESIGN.md'), specContent);
    writeFileSync(join(testDir, 'src', 'page.tsx'), '<OldButton onClick={handleClick}>Submit</OldButton>');

    const result = detectSpecDrift(['src/page.tsx'], testDir, join(testDir, 'docs'));
    expect(result.total_violations).toBeGreaterThan(0);
    expect(result.design_violations.length).toBe(1);
  });

  it('skips non-existent files', () => {
    const specContent = `---
type: copy_audit
applies_to: all
---

## Banned

| Term | Replacement | Reason |
|------|-------------|--------|
| utilize | use | Plain English |
`;
    writeFileSync(join(testDir, 'docs', 'COPY_AUDIT.md'), specContent);

    const result = detectSpecDrift(['src/missing.ts'], testDir, join(testDir, 'docs'));
    expect(result.total_violations).toBe(0);
  });
});

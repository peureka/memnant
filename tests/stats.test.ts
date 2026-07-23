/**
 * Tests for ledger stats.
 *
 * Task 8: Stats query module and CLI command.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import { retractRecord, archiveRecord } from '../src/ledger/admin.js';
import { getLedgerStats } from '../src/ledger/stats.js';

const PROJECT_ID = 'test-project-id';
const DUMMY_EMBEDDING = new Uint8Array(1536);
const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('getLedgerStats', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-stats-'));
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

  function insertTestRecord(content: string, type: string = 'decision') {
    return insertRecord(db, {
      projectId: PROJECT_ID,
      type: type as 'decision',
      contentText: content,
      embedding: DUMMY_EMBEDDING,
    });
  }

  // Store a codebase_snapshot with the given dependency versions.
  function seedSnapshot(deps: Record<string, string>) {
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, created_at)
       VALUES (?, ?, 'codebase_snapshot', ?, 'snapshot', ?, ?)`,
      [
        'snap-1',
        PROJECT_ID,
        JSON.stringify({ files: [], dependencies: deps, file_count: 0 }),
        DUMMY_EMBEDDING,
        new Date().toISOString(),
      ],
    );
  }

  function writePkg(deps: Record<string, string>) {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: deps }, null, 2),
    );
  }

  it('staleCount reflects a dynamically stale record when the codebase changed', async () => {
    // left-pad moved 1.0 -> 2.0 in package.json vs the stored snapshot, and a
    // framework_fix mentions left-pad → it is live-stale.
    writePkg({ 'left-pad': '^2.0.0' });
    seedSnapshot({ 'left-pad': '^1.0.0' });
    insertTestRecord('Pinned left-pad after the breaking 2.0 upgrade', 'framework_fix');

    const stats = await getLedgerStats(db, testDir);
    expect(stats.staleness.staleCount).toBe(1);
  });

  it('staleCount is 0 when nothing is dynamically stale', async () => {
    // Snapshot deps match current deps → no dependency change → nothing stale.
    writePkg({ 'left-pad': '^1.0.0' });
    seedSnapshot({ 'left-pad': '^1.0.0' });
    insertTestRecord('Pinned left-pad after the breaking 2.0 upgrade', 'framework_fix');

    const stats = await getLedgerStats(db, testDir);
    expect(stats.staleness.staleCount).toBe(0);
  });

  it('staleCount is 0 (no crash) when no codebase snapshot exists', async () => {
    writePkg({ 'left-pad': '^2.0.0' });
    // no snapshot seeded — staleness is legitimately unknown/zero, never an error
    insertTestRecord('Pinned left-pad after the breaking 2.0 upgrade', 'framework_fix');

    const stats = await getLedgerStats(db, testDir);
    expect(stats.staleness.staleCount).toBe(0);
  });

  it('returns record counts by type', async () => {
    insertTestRecord('Decision A');
    insertTestRecord('Decision B');
    insertTestRecord('Fix C', 'framework_fix');

    const stats = await getLedgerStats(db);
    expect(stats.records.total).toBe(3);
    expect(stats.records.active).toBe(3);
    expect(stats.records.byType['decision']).toBe(2);
    expect(stats.records.byType['framework_fix']).toBe(1);
  });

  it('returns retracted and archived counts', async () => {
    const r1 = insertTestRecord('Decision to retract');
    const r2 = insertTestRecord('Decision to archive');
    insertTestRecord('Decision to keep');

    retractRecord(db, r1.id, 'Wrong');
    archiveRecord(db, r2.id);

    const stats = await getLedgerStats(db);
    expect(stats.records.total).toBe(3);
    expect(stats.records.active).toBe(1);
    expect(stats.records.retracted).toBe(1);
    expect(stats.records.archived).toBe(1);
  });

  it('returns session count', async () => {
    const stats = await getLedgerStats(db);
    expect(stats.sessions.total).toBe(0);
    expect(stats.sessions.lastSessionAt).toBeNull();
  });

  it('returns contradiction count', async () => {
    const r1 = insertTestRecord('Auth: use JWT');
    const r2 = insertTestRecord('Auth: use sessions');

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-contra-1', ?, ?, 'contradicts', 0.8, ?)`,
      [r1.id, r2.id, new Date().toISOString()],
    );

    const stats = await getLedgerStats(db);
    expect(stats.contradictions.unresolvedCount).toBe(1);
  });

  it('returns graph connection count', async () => {
    const r1 = insertTestRecord('Decision X');
    const r2 = insertTestRecord('Decision Y');

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-1', ?, ?, 'related', 0.8, ?)`,
      [r1.id, r2.id, new Date().toISOString()],
    );

    const stats = await getLedgerStats(db);
    expect(stats.graph.connectionCount).toBe(1);
  });

  it('returns most connected record', async () => {
    const r1 = insertTestRecord('Hub record');
    const r2 = insertTestRecord('Spoke A');
    const r3 = insertTestRecord('Spoke B');

    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-a', ?, ?, 'related', 0.8, ?)`,
      [r1.id, r2.id, new Date().toISOString()],
    );
    db.run(
      `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES ('rel-b', ?, ?, 'related', 0.8, ?)`,
      [r1.id, r3.id, new Date().toISOString()],
    );

    const stats = await getLedgerStats(db);
    expect(stats.mostConnected).not.toBeNull();
    expect(stats.mostConnected!.id).toBe(r1.id);
    expect(stats.mostConnected!.connectionCount).toBe(2);
  });

  it('returns age stats', async () => {
    insertTestRecord('First record');

    const stats = await getLedgerStats(db);
    expect(stats.age.oldestRecord).not.toBeNull();
    expect(stats.age.newestRecord).not.toBeNull();
  });

  it('returns null for age when no records', async () => {
    const stats = await getLedgerStats(db);
    expect(stats.age.oldestRecord).toBeNull();
    expect(stats.age.newestRecord).toBeNull();
    expect(stats.mostConnected).toBeNull();
  });

  it('returns engagement with zero sessions', async () => {
    const stats = await getLedgerStats(db);
    expect(stats.engagement.sessionNumber).toBe(0);
    expect(stats.engagement.avgDaysBetween).toBeNull();
    expect(stats.engagement.currentStreakWeeks).toBe(0);
  });

  it('computes engagement metrics from multiple sessions', async () => {
    const now = new Date();
    // Insert 4 sessions over 9 days, newest today — the current week must
    // contain a session or currentStreakWeeks is legitimately 0 (a newest
    // session "1 day ago" falls into last week when the suite runs on a Monday)
    for (let i = 0; i < 4; i++) {
      const d = new Date(now.getTime() - (9 - i * 3) * 24 * 60 * 60 * 1000);
      db.run(
        'INSERT INTO session (id, project_id, started_at, closed_at) VALUES (?, ?, ?, ?)',
        [`s${i}`, PROJECT_ID, d.toISOString(), d.toISOString()],
      );
    }

    const stats = await getLedgerStats(db);
    expect(stats.engagement.sessionNumber).toBe(4);
    expect(stats.engagement.avgDaysBetween).toBeGreaterThan(0);
    expect(stats.engagement.medianDaysBetween).toBeGreaterThan(0);
    expect(stats.engagement.timeToSession3Days).toBeGreaterThan(0);
    expect(stats.engagement.longestGapDays).toBeGreaterThan(0);
    expect(stats.engagement.currentStreakWeeks).toBeGreaterThanOrEqual(1);
  });

  it('computes time to session 3', async () => {
    const now = new Date();
    // Session 1: 20 days ago, Session 2: 15 days ago, Session 3: 5 days ago
    const dates = [20, 15, 5];
    for (let i = 0; i < dates.length; i++) {
      const d = new Date(now.getTime() - dates[i] * 24 * 60 * 60 * 1000);
      db.run(
        'INSERT INTO session (id, project_id, started_at, closed_at) VALUES (?, ?, ?, ?)',
        [`sess${i}`, PROJECT_ID, d.toISOString(), d.toISOString()],
      );
    }

    const stats = await getLedgerStats(db);
    expect(stats.engagement.timeToSession3Days).toBeCloseTo(15, 0);
  });
});

describe('memnant stats CLI', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-stats-cli-'));
    runMemnant(['init'], testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('prints stats dashboard', async () => {
    const result = runMemnant(['stats'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('memnant stats');
    expect(result.stdout).toContain('Records:');
    expect(result.stdout).toContain('Sessions:');
    expect(result.stdout).toContain('Health:');
  });

  it('--json outputs valid JSON with engagement', async () => {
    const result = runMemnant(['stats', '--json'], testDir);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty('records');
    expect(data).toHaveProperty('sessions');
    expect(data).toHaveProperty('staleness');
    expect(data).toHaveProperty('contradictions');
    expect(data).toHaveProperty('graph');
    expect(data).toHaveProperty('age');
    expect(data).toHaveProperty('engagement');
    expect(data.engagement).toHaveProperty('sessionNumber');
  });

  it('fails without project', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-nostats-'));
    const result = runMemnant(['stats'], emptyDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No memnant project found');
    await rm(emptyDir, { recursive: true, force: true });
  });
});

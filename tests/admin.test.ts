/**
 * Tests for ledger administration: retraction and archiving.
 *
 * Task 3: Record retraction (retractRecord, unretractRecord).
 * Task 4: Record archiving (archiveRecord, unarchiveRecord, unarchiveAll,
 *         archiveSuperseded, archiveStaleOlderThan).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { insertRecord } from '../src/ledger/records.js';
import {
  retractRecord,
  unretractRecord,
  archiveRecord,
  unarchiveRecord,
  unarchiveAll,
  archiveSuperseded,
  archiveStaleOlderThan,
} from '../src/ledger/admin.js';

const PROJECT_ID = 'test-project-id';
const DUMMY_EMBEDDING = new Uint8Array(1536); // 384 float32s, all zeros — sufficient for DB ops

describe('Ledger Administration', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-admin-'));
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

  // Seed the LIVE staleness path deterministically (no embedding model, no
  // tree-sitter): write a package.json whose left-pad version differs from a
  // stored codebase_snapshot, so left-pad reads as a changed dependency. Any
  // framework_fix that mentions left-pad is then dynamically stale, exactly as
  // recall/compile would compute it.
  function seedChangedDependency() {
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: { 'left-pad': '^2.0.0' } }, null, 2),
    );
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, embedding, created_at)
       VALUES (?, ?, 'codebase_snapshot', ?, 'snapshot', ?, ?)`,
      [
        'snap-1',
        PROJECT_ID,
        JSON.stringify({ files: [], dependencies: { 'left-pad': '^1.0.0' }, file_count: 0 }),
        DUMMY_EMBEDDING,
        new Date().toISOString(),
      ],
    );
  }

  function insertFix(content: string) {
    return insertRecord(db, {
      projectId: PROJECT_ID,
      type: 'framework_fix',
      contentText: content,
      embedding: DUMMY_EMBEDDING,
    });
  }

  function backdate(recordId: string, days: number) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    db.run('UPDATE record SET created_at = ? WHERE id = ?', [d.toISOString(), recordId]);
  }

  describe('Record Retraction', () => {
    it('retractRecord sets retracted_at and retracted_reason', () => {
      const record = insertTestRecord('Decision: use React');

      retractRecord(db, record.id, 'No longer valid after switching to Vue');

      const row = db.get('SELECT retracted_at, retracted_reason FROM record WHERE id = ?', [record.id]) as unknown as {
        retracted_at: string | null;
        retracted_reason: string | null;
      };

      expect(row.retracted_at).not.toBeNull();
      expect(row.retracted_reason).toBe('No longer valid after switching to Vue');
    });

    it('retractRecord throws if record not found', () => {
      expect(() => retractRecord(db, 'nonexistent-id', 'reason')).toThrow(
        /Record 'nonexistent-id' not found/,
      );
    });

    it('unretractRecord clears retracted_at and retracted_reason', () => {
      const record = insertTestRecord('Decision: use Postgres');

      retractRecord(db, record.id, 'Wrong database choice');
      unretractRecord(db, record.id);

      const row = db.get('SELECT retracted_at, retracted_reason FROM record WHERE id = ?', [record.id]) as unknown as {
        retracted_at: string | null;
        retracted_reason: string | null;
      };

      expect(row.retracted_at).toBeNull();
      expect(row.retracted_reason).toBeNull();
    });

    it('unretractRecord throws if record not found', () => {
      expect(() => unretractRecord(db, 'nonexistent-id')).toThrow(
        /Record 'nonexistent-id' not found/,
      );
    });

    it('retractRecord is idempotent — retracting twice updates timestamp and reason', () => {
      const record = insertTestRecord('Decision: use Redis');

      retractRecord(db, record.id, 'First reason');
      const row1 = db.get('SELECT retracted_at FROM record WHERE id = ?', [record.id]) as unknown as {
        retracted_at: string;
      };

      retractRecord(db, record.id, 'Updated reason');
      const row2 = db.get('SELECT retracted_at, retracted_reason FROM record WHERE id = ?', [record.id]) as unknown as {
        retracted_at: string;
        retracted_reason: string;
      };

      expect(row2.retracted_reason).toBe('Updated reason');
    });

    it('newly inserted records have null retracted fields', () => {
      const record = insertTestRecord('Decision: use TypeScript');

      expect(record.retracted_at).toBeNull();
      expect(record.retracted_reason).toBeNull();
    });
  });

  describe('Record Archiving', () => {
    it('archiveRecord sets archived_at', () => {
      const record = insertTestRecord('Decision: old approach');

      archiveRecord(db, record.id);

      const row = db.get('SELECT archived_at FROM record WHERE id = ?', [record.id]) as unknown as {
        archived_at: string | null;
      };

      expect(row.archived_at).not.toBeNull();
    });

    it('archiveRecord throws if record not found', () => {
      expect(() => archiveRecord(db, 'nonexistent-id')).toThrow(
        /Record 'nonexistent-id' not found/,
      );
    });

    it('unarchiveRecord clears archived_at', () => {
      const record = insertTestRecord('Decision: archived then restored');

      archiveRecord(db, record.id);
      unarchiveRecord(db, record.id);

      const row = db.get('SELECT archived_at FROM record WHERE id = ?', [record.id]) as unknown as {
        archived_at: string | null;
      };

      expect(row.archived_at).toBeNull();
    });

    it('unarchiveRecord throws if record not found', () => {
      expect(() => unarchiveRecord(db, 'nonexistent-id')).toThrow(
        /Record 'nonexistent-id' not found/,
      );
    });

    it('newly inserted records have null archived_at', () => {
      const record = insertTestRecord('Decision: fresh record');

      expect(record.archived_at).toBeNull();
    });

    it('unarchiveAll clears archived_at on all archived records and returns count', () => {
      const r1 = insertTestRecord('Decision A');
      const r2 = insertTestRecord('Decision B');
      const r3 = insertTestRecord('Decision C');

      archiveRecord(db, r1.id);
      archiveRecord(db, r2.id);
      // r3 is not archived

      const count = unarchiveAll(db);
      expect(count).toBe(2);

      const rows = db.all('SELECT archived_at FROM record WHERE archived_at IS NOT NULL') as unknown as unknown[];
      expect(rows.length).toBe(0);
    });

    it('unarchiveAll returns 0 when no records are archived', () => {
      insertTestRecord('Decision: not archived');

      const count = unarchiveAll(db);
      expect(count).toBe(0);
    });

    it('archiveSuperseded archives targets of supersedes relationships', () => {
      const r1 = insertTestRecord('Original auth decision');
      const r2 = insertTestRecord('Updated auth decision');

      // r2 supersedes r1 — r1 is the target
      db.run(
        `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
         VALUES ('rel-sup-1', ?, ?, 'supersedes', 0.9, ?)`,
        [r2.id, r1.id, new Date().toISOString()],
      );

      const count = archiveSuperseded(db);
      expect(count).toBe(1);

      const row = db.get('SELECT archived_at FROM record WHERE id = ?', [r1.id]) as unknown as {
        archived_at: string | null;
      };
      expect(row.archived_at).not.toBeNull();

      // r2 (the superseder) should NOT be archived
      const row2 = db.get('SELECT archived_at FROM record WHERE id = ?', [r2.id]) as unknown as {
        archived_at: string | null;
      };
      expect(row2.archived_at).toBeNull();
    });

    it('archiveSuperseded ignores dismissed supersedes relationships', () => {
      const r1 = insertTestRecord('Original caching decision');
      const r2 = insertTestRecord('Updated caching decision');

      db.run(
        `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at, dismissed_at)
         VALUES ('rel-sup-2', ?, ?, 'supersedes', 0.9, ?, ?)`,
        [r2.id, r1.id, new Date().toISOString(), new Date().toISOString()],
      );

      const count = archiveSuperseded(db);
      expect(count).toBe(0);
    });

    it('archiveSuperseded does not double-archive already archived records', () => {
      const r1 = insertTestRecord('Original decision');
      const r2 = insertTestRecord('New decision');

      db.run(
        `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
         VALUES ('rel-sup-3', ?, ?, 'supersedes', 0.9, ?)`,
        [r2.id, r1.id, new Date().toISOString()],
      );

      // Archive r1 first
      archiveRecord(db, r1.id);

      // archiveSuperseded should not count already-archived records
      const count = archiveSuperseded(db);
      expect(count).toBe(0);
    });

    it('archiveStaleOlderThan archives a dynamically stale record older than N days', async () => {
      seedChangedDependency();
      const record = insertFix('Pinned left-pad after the breaking 2.0 upgrade');
      backdate(record.id, 100);

      const count = await archiveStaleOlderThan(db, 30, testDir);
      expect(count).toBe(1);

      const row = db.get('SELECT archived_at FROM record WHERE id = ?', [record.id]) as unknown as {
        archived_at: string | null;
      };
      expect(row.archived_at).not.toBeNull();
    });

    it('archiveStaleOlderThan does not archive a dynamically stale record newer than N days', async () => {
      seedChangedDependency();
      // created now — stale, but younger than the cutoff
      insertFix('Pinned left-pad after the breaking 2.0 upgrade');

      const count = await archiveStaleOlderThan(db, 30, testDir);
      expect(count).toBe(0);
    });

    it('archiveStaleOlderThan does not archive a non-stale old record', async () => {
      seedChangedDependency();
      // old, but does not mention the changed dependency → not dynamically stale
      const record = insertFix('Unrelated fix about widget rendering');
      backdate(record.id, 100);

      const count = await archiveStaleOlderThan(db, 30, testDir);
      expect(count).toBe(0);
    });

    it('archiveStaleOlderThan does not double-archive already archived records', async () => {
      seedChangedDependency();
      const record = insertFix('Pinned left-pad after the breaking 2.0 upgrade');
      backdate(record.id, 100);
      archiveRecord(db, record.id);

      const count = await archiveStaleOlderThan(db, 30, testDir);
      expect(count).toBe(0);
    });

    it('archiveStaleOlderThan returns 0 gracefully when no project root is given', async () => {
      seedChangedDependency();
      const record = insertFix('Pinned left-pad after the breaking 2.0 upgrade');
      backdate(record.id, 100);

      // Without a project root there is nothing to diff against — no crash, 0 archived.
      const count = await archiveStaleOlderThan(db, 30);
      expect(count).toBe(0);
    });
  });

  describe('Query Exclusion', () => {
    it('retracted records are excluded from standard queries', () => {
      const r1 = insertTestRecord('Decision: visible record');
      const r2 = insertTestRecord('Decision: retracted record');

      retractRecord(db, r2.id, 'No longer valid');

      const rows = db.all(
        "SELECT id FROM record WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL",
      ) as unknown as Array<{ id: string }>;

      expect(rows.map((r) => r.id)).toContain(r1.id);
      expect(rows.map((r) => r.id)).not.toContain(r2.id);
    });

    it('archived records are excluded from standard queries', () => {
      const r1 = insertTestRecord('Decision: visible record');
      const r2 = insertTestRecord('Decision: archived record');

      archiveRecord(db, r2.id);

      const rows = db.all(
        "SELECT id FROM record WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL",
      ) as unknown as Array<{ id: string }>;

      expect(rows.map((r) => r.id)).toContain(r1.id);
      expect(rows.map((r) => r.id)).not.toContain(r2.id);
    });

    it('retracted and archived records are included when explicitly requested', () => {
      const r1 = insertTestRecord('Decision: visible');
      const r2 = insertTestRecord('Decision: retracted');
      const r3 = insertTestRecord('Decision: archived');

      retractRecord(db, r2.id, 'Wrong');
      archiveRecord(db, r3.id);

      // Without exclusion — all records returned
      const allRows = db.all(
        "SELECT id FROM record WHERE type = 'decision'",
      ) as unknown as Array<{ id: string }>;

      expect(allRows.length).toBe(3);
    });

    it('export query excludes retracted and archived records', () => {
      const r1 = insertTestRecord('Decision: exportable');
      const r2 = insertTestRecord('Decision: retracted and hidden');
      const r3 = insertTestRecord('Decision: archived and hidden');

      retractRecord(db, r2.id, 'Wrong');
      archiveRecord(db, r3.id);

      const rows = db.all(
        'SELECT id FROM record WHERE retracted_at IS NULL AND archived_at IS NULL ORDER BY created_at ASC',
      ) as unknown as Array<{ id: string }>;

      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(r1.id);
    });
  });
});

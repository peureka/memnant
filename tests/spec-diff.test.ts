/**
 * Tests for Spec Snapshot Diffing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import { snapshotSpecIfChanged, getSpecSnapshots, diffSpecSnapshots } from '../src/context/spec-diff.js';

describe('Spec Snapshot Diffing', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-spec-diff-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES ('test-proj', 'test', '/tmp/test', '2025-01-01T00:00:00.000Z')",
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates a spec snapshot when no previous snapshot exists', () => {
    const specContent = '---\ntype: copy_audit\nversion: 1\napplies_to: all\n---\n## Banned\n- "platform" → "product"\n';

    const result = snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', specContent, 'copy_audit', '1');

    expect(result.changed).toBe(true);
    expect(result.isNew).toBe(true);

    const snapshots = getSpecSnapshots(db, 'copy-audit.md');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].content_text).toBe(specContent);
  });

  it('does not create a snapshot when content is unchanged', () => {
    const specContent = '---\ntype: copy_audit\n---\n## Banned\n- "foo"\n';

    snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', specContent, 'copy_audit', '1');
    const result = snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', specContent, 'copy_audit', '1');

    expect(result.changed).toBe(false);

    const snapshots = getSpecSnapshots(db, 'copy-audit.md');
    expect(snapshots).toHaveLength(1);
  });

  it('creates a new snapshot when content changes', () => {
    const v1 = '---\ntype: copy_audit\n---\n## Banned\n- "foo"\n';
    const v2 = '---\ntype: copy_audit\n---\n## Banned\n- "foo"\n- "bar"\n';

    snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', v1, 'copy_audit', '1');
    const result = snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', v2, 'copy_audit', '2');

    expect(result.changed).toBe(true);
    expect(result.isNew).toBe(false);

    const snapshots = getSpecSnapshots(db, 'copy-audit.md');
    expect(snapshots).toHaveLength(2);
  });

  it('diffs two spec snapshots', () => {
    const v1 = '---\ntype: copy_audit\n---\n## Banned\n- "foo"\n';
    const v2 = '---\ntype: copy_audit\n---\n## Banned\n- "foo"\n- "bar"\n';

    snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', v1, 'copy_audit', '1');
    snapshotSpecIfChanged(db, 'test-proj', 'copy-audit.md', v2, 'copy_audit', '2');

    const diff = diffSpecSnapshots(db, 'copy-audit.md');
    expect(diff).not.toBeNull();
    expect(diff!.filename).toBe('copy-audit.md');
    expect(diff!.diff).toContain('+ - "bar"');
  });
});

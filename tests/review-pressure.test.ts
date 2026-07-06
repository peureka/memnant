import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findDecisionsDueForReview } from '../src/relevance/review-pressure.js';
import { createDatabase } from '../src/ledger/database.js';

describe('review pressure', () => {
  const testDir = join(tmpdir(), 'memnant-review-pressure-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('flags old decisions without recent access', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()],
    );

    // Insert a decision from 100 days ago
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['old-1', 'test', 'decision', '{}', 'Old architecture decision', '[]', '[]', oldDate],
    );

    // Insert a recent decision (5 days ago)
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['new-1', 'test', 'decision', '{}', 'Recent decision', '[]', '[]', recentDate],
    );

    const candidates = findDecisionsDueForReview(db, 'test', 90);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('old-1');
    expect(candidates[0].content_text).toBe('Old architecture decision');

    db.close();
  });

  it('excludes old decisions that were recently accessed', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()],
    );

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['old-1', 'test', 'decision', '{}', 'Old but accessed decision', '[]', '[]', oldDate],
    );

    // Add recent access
    const recentAccess = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      "INSERT INTO record_access (record_id, accessed_at, context) VALUES (?, ?, ?)",
      ['old-1', recentAccess, 'recall'],
    );

    const candidates = findDecisionsDueForReview(db, 'test', 90);
    expect(candidates).toHaveLength(0);

    db.close();
  });

  it('excludes retracted and archived records', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()],
    );

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    db.run(
      `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, retracted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['retracted-1', 'test', 'decision', '{}', 'Retracted', '[]', '[]', oldDate, new Date().toISOString()],
    );

    const candidates = findDecisionsDueForReview(db, 'test', 90);
    expect(candidates).toHaveLength(0);

    db.close();
  });

  it('returns empty when days is 0 (disabled)', () => {
    const dbPath = join(testDir, 'ledger.db');
    const db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)",
      ['test', 'Test', '/tmp', new Date().toISOString()],
    );

    const candidates = findDecisionsDueForReview(db, 'test', 0);
    expect(candidates).toEqual([]);

    db.close();
  });
});

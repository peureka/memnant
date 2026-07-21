/**
 * Story S1 — Choreography module.
 *
 * computeChoreography derives advisory "what the workflow expects next"
 * nudges from ledger + doc state. Each stage fires ONLY when its
 * precondition holds; silent otherwise. Config-declared stages, no
 * hardcoded review pipeline (review_tag is configurable).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase, type Database } from '../src/ledger/database.js';
import {
  computeChoreography,
  DEFAULT_STAGES,
  DEFAULT_REVIEW_TAG,
} from '../src/context/choreography.js';

const PID = 'test-project';

function insertDecision(
  db: Database,
  id: string,
  contentText: string,
  opts: { tags?: string[]; assumptions?: string[]; createdAt?: string; sourceSession?: string } = {},
): void {
  db.run(
    `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at, assumptions, source_session)
     VALUES (?, ?, 'decision', '{}', ?, ?, '[]', ?, ?, ?)`,
    [
      id,
      PID,
      contentText,
      JSON.stringify(opts.tags ?? []),
      opts.createdAt ?? new Date().toISOString(),
      opts.assumptions ? JSON.stringify(opts.assumptions) : null,
      opts.sourceSession ?? null,
    ],
  );
}

function insertSpecSnapshot(db: Database, id: string, fullText: string): void {
  const content = JSON.stringify({ filename: `${id}.md`, content_hash: id, spec_type: 'product_spec', full_text: fullText });
  db.run(
    `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
     VALUES (?, ?, 'spec_snapshot', ?, ?, '["spec_snapshot"]', '[]', ?)`,
    [id, PID, content, fullText, new Date().toISOString()],
  );
}

describe('Choreography', () => {
  const testDir = join(tmpdir(), 'memnant-choreo-' + Date.now());
  let db: Database;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    db = createDatabase(join(testDir, 'ledger.db'));
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'Test', ?, ?)",
      [PID, testDir, new Date().toISOString()],
    );
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('is quiet when no preconditions are met', () => {
    const nudges = computeChoreography(db, { projectId: PID, epic: 'auth' });
    expect(nudges).toEqual([]);
  });

  it('rejection guard fires when a rejected decision matches the epic', () => {
    insertDecision(db, 'd1', 'Tried server-side sessions for auth, rejected', { tags: ['rejected', 'auth'] });
    const nudges = computeChoreography(db, { projectId: PID, epic: 'auth' });
    const rejection = nudges.find((n) => n.stage === 'rejection');
    expect(rejection).toBeDefined();
    expect(rejection!.message.toLowerCase()).toContain('rejected');
    expect(rejection!.refs).toContain('d1');
  });

  it('spec gate fires when epic has decisions but no covering spec snapshot', () => {
    insertDecision(db, 'd1', 'Chose JWT for the auth epic', { tags: ['auth'] });
    const nudges = computeChoreography(db, { projectId: PID, epic: 'auth' });
    const specGate = nudges.find((n) => n.stage === 'spec_gate');
    expect(specGate).toBeDefined();
    expect(specGate!.message.toLowerCase()).toContain('spec');
  });

  it('spec gate is silent once a covering spec snapshot exists, and review gate fires', () => {
    insertDecision(db, 'd1', 'Chose JWT for the auth epic', { tags: ['auth'] });
    insertSpecSnapshot(db, 's1', 'Auth spec: JWT tokens, refresh flow, expiry');
    const nudges = computeChoreography(db, { projectId: PID, epic: 'auth' });
    expect(nudges.find((n) => n.stage === 'spec_gate')).toBeUndefined();
    const reviewGate = nudges.find((n) => n.stage === 'review_gate');
    expect(reviewGate).toBeDefined();
    expect(reviewGate!.message).toContain(DEFAULT_REVIEW_TAG);
  });

  it('review gate clears when a record carries the review tag for the epic', () => {
    insertDecision(db, 'd1', 'Chose JWT for the auth epic', { tags: ['auth'] });
    insertSpecSnapshot(db, 's1', 'Auth spec: JWT tokens, refresh flow, expiry');
    insertDecision(db, 'd2', 'Auth spec reviewed and approved', { tags: ['auth', DEFAULT_REVIEW_TAG] });
    const nudges = computeChoreography(db, { projectId: PID, epic: 'auth' });
    expect(nudges.find((n) => n.stage === 'review_gate')).toBeUndefined();
  });

  it('review gate keys off a configurable review_tag, not a hardcoded Codex assumption', () => {
    insertDecision(db, 'd1', 'Chose JWT for the auth epic', { tags: ['auth'] });
    insertSpecSnapshot(db, 's1', 'Auth spec: JWT tokens, refresh flow, expiry');
    // A default-tag review record must NOT satisfy a custom review_tag.
    insertDecision(db, 'd2', 'Reviewed with default tag', { tags: ['auth', DEFAULT_REVIEW_TAG] });
    const custom = computeChoreography(db, { projectId: PID, epic: 'auth', reviewTag: 'peer-review' });
    const reviewGate = custom.find((n) => n.stage === 'review_gate');
    expect(reviewGate).toBeDefined();
    expect(reviewGate!.message).toContain('peer-review');

    // Add the custom-tag record — gate clears.
    insertDecision(db, 'd3', 'Reviewed by peer', { tags: ['auth', 'peer-review'] });
    const cleared = computeChoreography(db, { projectId: PID, epic: 'auth', reviewTag: 'peer-review' });
    expect(cleared.find((n) => n.stage === 'review_gate')).toBeUndefined();
  });

  it('churn escalation fires when a supersession chain is 3+ deep', () => {
    const now = new Date().toISOString();
    for (const id of ['rA', 'rB', 'rC', 'rD']) {
      insertDecision(db, id, 'Database choice');
    }
    db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at) VALUES ('s1', 'rB', 'rA', 'supersedes', 0.9, ?)`, [now]);
    db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at) VALUES ('s2', 'rC', 'rB', 'supersedes', 0.9, ?)`, [now]);
    db.run(`INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at) VALUES ('s3', 'rD', 'rC', 'supersedes', 0.9, ?)`, [now]);
    const nudges = computeChoreography(db, { projectId: PID });
    const churn = nudges.find((n) => n.stage === 'churn');
    expect(churn).toBeDefined();
    expect(churn!.message).toContain('Database choice');
  });

  it('assumption re-check fires when live decisions carry assumptions', () => {
    insertDecision(db, 'd1', 'Pricing is one-time purchase', { assumptions: ['users pay once'] });
    const nudges = computeChoreography(db, { projectId: PID });
    const assumption = nudges.find((n) => n.stage === 'assumptions');
    expect(assumption).toBeDefined();
    expect(assumption!.message).toContain('users pay once');
  });

  it('review pressure fires for old, unaccessed decisions', () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    insertDecision(db, 'old-1', 'Old architecture decision', { createdAt: oldDate });
    const nudges = computeChoreography(db, { projectId: PID, reviewPressureDays: 90 });
    const rp = nudges.find((n) => n.stage === 'review_pressure');
    expect(rp).toBeDefined();
    expect(rp!.refs).toContain('old-1');
  });

  it('close reminder fires when the session is open and records were logged in it', () => {
    db.run(
      "INSERT INTO session (id, project_id, started_at, closed_at) VALUES ('sess-1', ?, ?, NULL)",
      [PID, new Date().toISOString()],
    );
    insertDecision(db, 'd1', 'Logged this session', { sourceSession: 'sess-1' });
    const nudges = computeChoreography(db, { projectId: PID });
    const close = nudges.find((n) => n.stage === 'close');
    expect(close).toBeDefined();
    expect(close!.message.toLowerCase()).toContain('close');
  });

  it('only emits stages named in the stages list', () => {
    insertDecision(db, 'd1', 'Rejected auth approach', { tags: ['rejected', 'auth'] });
    insertDecision(db, 'd2', 'Has assumption', { assumptions: ['x is true'] });
    const nudges = computeChoreography(db, { projectId: PID, epic: 'auth', stages: ['rejection'] });
    expect(nudges.every((n) => n.stage === 'rejection')).toBe(true);
    expect(nudges.find((n) => n.stage === 'assumptions')).toBeUndefined();
  });

  it('exports sensible defaults', () => {
    expect(DEFAULT_REVIEW_TAG).toBe('codex-review');
    expect(DEFAULT_STAGES).toContain('rejection');
    expect(DEFAULT_STAGES).toContain('spec_gate');
    expect(DEFAULT_STAGES).toContain('review_gate');
    expect(DEFAULT_STAGES).toContain('churn');
    expect(DEFAULT_STAGES).toContain('assumptions');
    expect(DEFAULT_STAGES).toContain('close');
  });
});

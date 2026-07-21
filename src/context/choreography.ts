/**
 * memnant — Choreography layer.
 *
 * Derives advisory "what the workflow expects next" nudges from ledger +
 * doc state at compile time. This is the deterministic 60/30 of PJ's
 * 60/30/10: memnant computes the process, the host agent runs the 10%
 * (grill, review, code). memnant NEVER executes a model or tool step.
 *
 * Design invariants (see docs/plans/2026-07-21-choreography-in-session-context.md):
 * 1. Advisory only — emits guidance, never acts.
 * 2. Config-declared — stages and review_tag come from config, not hardcode.
 * 3. Derived state — computed from records/snapshots, no new storage.
 * 4. Quiet when irrelevant — each nudge fires only when its precondition holds.
 */

import type { Database } from '../ledger/database.js';
import type { ProcessNudge } from '../types.js';
import { getActiveAssumptions } from './assumptions.js';
import { computeChurnMetrics, formatChurnAlerts } from '../analytics/churn.js';
import { findDecisionsDueForReview } from '../relevance/review-pressure.js';
import { getActiveSession } from '../ledger/sessions.js';

/** The tag that signals a spec has been cross-reviewed. Configurable — memnant does not assume Codex. */
export const DEFAULT_REVIEW_TAG = 'codex-review';

/** The stages shipped on by default. Each is individually removable via config. */
export const DEFAULT_STAGES = [
  'rejection',
  'spec_gate',
  'review_gate',
  'churn',
  'assumptions',
  'review_pressure',
  'close',
] as const;

export interface ChoreographyOptions {
  projectId: string;
  epic?: string;
  reviewTag?: string;
  stages?: readonly string[];
  reviewPressureDays?: number;
}

/** SQLite JSON-array LIKE fragment for an exact tag match. */
function tagLike(tag: string): string {
  return `%"${tag}"%`;
}

/**
 * Compute the advisory nudge set from ledger state.
 * Pure read — no writes, no side effects. Each stage is gated by the
 * enabled `stages` list AND its own precondition.
 */
export function computeChoreography(db: Database, opts: ChoreographyOptions): ProcessNudge[] {
  const enabled = new Set(opts.stages ?? DEFAULT_STAGES);
  const reviewTag = opts.reviewTag ?? DEFAULT_REVIEW_TAG;
  const epic = opts.epic;
  const nudges: ProcessNudge[] = [];

  // 1. Rejection guard — a rejected approach relevant to the epic/topic.
  if (enabled.has('rejection')) {
    const params: string[] = [tagLike('rejected')];
    let sql = `SELECT id, content_text FROM record
       WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL
         AND tags LIKE ?`;
    if (epic) {
      sql += ` AND (tags LIKE ? OR content_text LIKE ?)`;
      params.push(`%${epic}%`, `%${epic}%`);
    }
    sql += ` ORDER BY created_at DESC LIMIT 10`;
    const rejected = db.all(sql, params) as unknown as Array<{ id: string; content_text: string }>;
    if (rejected.length > 0) {
      const previews = rejected.map((r) => r.content_text.split('\n')[0].slice(0, 100));
      nudges.push({
        stage: 'rejection',
        message: `Tried and rejected; do not re-propose: ${previews.join('; ')}`,
        refs: rejected.map((r) => r.id),
      });
    }
  }

  // Spec/review gates only make sense against an epic (the unit of "active work").
  const hasSnapshot = epic ? epicHasSpecSnapshot(db, epic) : false;

  // 2. Spec gate — active epic decisions but no covering spec snapshot.
  if (enabled.has('spec_gate') && epic && !hasSnapshot) {
    if (epicHasDecisions(db, epic)) {
      nudges.push({
        stage: 'spec_gate',
        message: `Active work on "${epic}" has no spec snapshot; write and snapshot a spec before implementing.`,
      });
    }
  }

  // 3. Review gate — spec snapshot exists but nothing carries the review tag for the epic.
  if (enabled.has('review_gate') && epic && hasSnapshot) {
    const reviewed = db.get(
      `SELECT 1 FROM record
       WHERE retracted_at IS NULL AND archived_at IS NULL
         AND tags LIKE ?
         AND (tags LIKE ? OR content_text LIKE ?)
       LIMIT 1`,
      [tagLike(reviewTag), `%${epic}%`, `%${epic}%`],
    ) as unknown as { 1: number } | undefined;
    if (!reviewed) {
      nudges.push({
        stage: 'review_gate',
        message: `Spec for "${epic}" not yet cross-reviewed (tag: ${reviewTag}). Review before implementing.`,
      });
    }
  }

  // 4. Churn escalation — supersession chains 3+ deep.
  if (enabled.has('churn')) {
    const metrics = computeChurnMetrics(db);
    if (metrics.length > 0) {
      const alerts = formatChurnAlerts(metrics);
      metrics.forEach((m, i) => {
        nudges.push({ stage: 'churn', message: alerts[i], refs: m.chainIds });
      });
    }
  }

  // 5. Assumption re-check — assumptions underpinning live decisions.
  if (enabled.has('assumptions')) {
    const active = getActiveAssumptions(db, opts.projectId);
    for (const a of active) {
      const n = a.decisions.length;
      nudges.push({
        stage: 'assumptions',
        message: `"${a.assumption}" — ${n} decision${n > 1 ? 's' : ''} depend on this; re-validate.`,
        refs: a.decisions.map((d) => d.id),
      });
    }
  }

  // 6. Review pressure — old, unaccessed decisions due for a look.
  if (enabled.has('review_pressure')) {
    const days = opts.reviewPressureDays ?? 90;
    const due = findDecisionsDueForReview(db, opts.projectId, days);
    for (const r of due) {
      nudges.push({
        stage: 'review_pressure',
        message: `[review? ${r.days_old}d] ${r.id.slice(0, 8)} — ${r.content_text.split('\n')[0].slice(0, 120)}`,
        refs: [r.id],
      });
    }
  }

  // 7. Close reminder — session open with records logged in it.
  if (enabled.has('close')) {
    const active = getActiveSession(db, opts.projectId);
    if (active) {
      const count = (
        db.get('SELECT COUNT(*) as count FROM record WHERE source_session = ?', [active.id]) as unknown as { count: number }
      ).count;
      if (count > 0) {
        nudges.push({
          stage: 'close',
          message: `Session has ${count} logged record${count > 1 ? 's' : ''} and is still open. Harvest worktrees, close the session via MCP, and export the log before cleanup.`,
        });
      }
    }
  }

  return nudges;
}

/** True if any spec_snapshot references the epic (by tag, full text, or content JSON). */
function epicHasSpecSnapshot(db: Database, epic: string): boolean {
  const row = db.get(
    `SELECT 1 FROM record
     WHERE type = 'spec_snapshot' AND retracted_at IS NULL AND archived_at IS NULL
       AND (tags LIKE ? OR content_text LIKE ? OR content LIKE ?)
     LIMIT 1`,
    [`%${epic}%`, `%${epic}%`, `%${epic}%`],
  ) as unknown as { 1: number } | undefined;
  return !!row;
}

/** True if any live decision references the epic. */
function epicHasDecisions(db: Database, epic: string): boolean {
  const row = db.get(
    `SELECT 1 FROM record
     WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL
       AND (tags LIKE ? OR content_text LIKE ?)
     LIMIT 1`,
    [`%${epic}%`, `%${epic}%`],
  ) as unknown as { 1: number } | undefined;
  return !!row;
}

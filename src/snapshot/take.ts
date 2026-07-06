/**
 * memnant — Shared codebase-snapshot creation.
 *
 * Extracted from the snapshot CLI so session start can take snapshots
 * automatically. Staleness detection is inert without a snapshot to diff
 * against, and a project that never ran `memnant snapshot` was never
 * warned — so sessions now self-heal: no snapshot (or one older than the
 * snapshot interval) means one is taken at session start.
 */
import type { Database } from 'node-sqlite3-wasm';
import { insertRecord } from '../ledger/records.js';
import { getActiveSession } from '../ledger/sessions.js';
import { generateEmbedding, serializeEmbedding } from '../vector/embeddings.js';
import {
  scanProject,
  diffSnapshots,
  buildSummaryText,
  getLastSnapshot,
  getLastSnapshotDate,
  pruneOldSnapshots,
} from './scanner.js';

const MONTHLY_INTERVAL_DAYS = 30;

export interface SnapshotResult {
  recordId: string;
  summaryText: string;
  pruned: number;
  diff: ReturnType<typeof diffSnapshots>;
}

/**
 * Scan the project and persist a codebase_snapshot record.
 */
export async function takeCodebaseSnapshot(
  db: Database,
  projectId: string,
  projectRoot: string,
  maxSnapshots: number,
): Promise<SnapshotResult> {
  const oldSnapshot = getLastSnapshot(db);
  const newSnapshot = scanProject(projectRoot);
  const diff = diffSnapshots(oldSnapshot, newSnapshot);
  const summaryText = buildSummaryText(newSnapshot, diff);

  const embedding = await generateEmbedding(summaryText);
  const embeddingBuffer = serializeEmbedding(embedding);
  const activeSession = getActiveSession(db, projectId);

  const record = insertRecord(db, {
    projectId,
    type: 'codebase_snapshot',
    contentText: summaryText,
    embedding: embeddingBuffer,
    sourceSession: activeSession?.id ?? null,
  });

  // The content field carries the full structured snapshot for diffing.
  db.run('UPDATE record SET content = ? WHERE id = ?', [JSON.stringify(newSnapshot), record.id]);

  const pruned = pruneOldSnapshots(db, maxSnapshots);

  return { recordId: record.id, summaryText, pruned, diff };
}

/**
 * Take a snapshot at session start when staleness tracking would otherwise
 * be inert: no snapshot exists at all (any interval — a first baseline is
 * required for the feature to exist), or the last one is older than the
 * monthly interval (only when snapshot_interval is 'monthly'; 'milestone'
 * projects refresh on their own schedule). Returns the result when a
 * snapshot was taken, null otherwise. Never throws — a failed auto-snapshot
 * must not block a session.
 */
export async function ensureFreshSnapshot(
  db: Database,
  projectId: string,
  projectRoot: string,
  maxSnapshots: number,
  interval: 'monthly' | 'milestone',
): Promise<SnapshotResult | null> {
  try {
    const lastDate = getLastSnapshotDate(db);
    if (lastDate) {
      if (interval !== 'monthly') return null;
      const daysSince = (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince <= MONTHLY_INTERVAL_DAYS) return null;
    }
    return await takeCodebaseSnapshot(db, projectId, projectRoot, maxSnapshots);
  } catch {
    return null;
  }
}

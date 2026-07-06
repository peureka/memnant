/**
 * memnant — Spec snapshot diffing.
 *
 * Auto-detects spec changes during context compilation,
 * stores snapshots as spec_snapshot records, and produces
 * unified diffs between versions.
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from '../ledger/database.js';

export interface SnapshotResult {
  changed: boolean;
  isNew: boolean;
}

export interface SpecSnapshotRow {
  id: string;
  content_text: string;
  created_at: string;
  tags: string;
}

export interface SpecDiff {
  filename: string;
  oldVersion: string;
  newVersion: string;
  diff: string;
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function snapshotSpecIfChanged(
  db: Database,
  projectId: string,
  filename: string,
  fullText: string,
  specType: string,
  version: string | undefined,
): SnapshotResult {
  const hash = contentHash(fullText);

  const lastSnapshot = db.get(
    `SELECT id, content FROM record
     WHERE type = 'spec_snapshot' AND retracted_at IS NULL AND archived_at IS NULL
       AND content LIKE ?
     ORDER BY created_at DESC LIMIT 1`,
    [`%"filename":"${filename}"%`],
  ) as unknown as { id: string; content: string } | undefined;

  if (lastSnapshot) {
    try {
      const parsed = JSON.parse(lastSnapshot.content);
      if (parsed.content_hash === hash) {
        return { changed: false, isNew: false };
      }
    } catch {
      // Invalid JSON — treat as changed
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const content = JSON.stringify({
    filename,
    content_hash: hash,
    spec_type: specType,
    version: version ?? null,
    full_text: fullText,
  });
  const tags = JSON.stringify(['spec_snapshot', specType]);

  db.run(
    `INSERT INTO record (id, project_id, type, content, content_text, tags, related_records, created_at)
     VALUES (?, ?, 'spec_snapshot', ?, ?, ?, '[]', ?)`,
    [id, projectId, content, fullText, tags, now],
  );

  return { changed: true, isNew: !lastSnapshot };
}

export function getSpecSnapshots(db: Database, filename: string): SpecSnapshotRow[] {
  return db.all(
    `SELECT id, content_text, created_at, tags FROM record
     WHERE type = 'spec_snapshot' AND retracted_at IS NULL AND archived_at IS NULL
       AND content LIKE ?
     ORDER BY created_at ASC`,
    [`%"filename":"${filename}"%`],
  ) as unknown as SpecSnapshotRow[];
}

export function diffSpecSnapshots(db: Database, filename: string): SpecDiff | null {
  const snapshots = db.all(
    `SELECT id, content, content_text, created_at FROM record
     WHERE type = 'spec_snapshot' AND retracted_at IS NULL AND archived_at IS NULL
       AND content LIKE ?
     ORDER BY created_at DESC LIMIT 2`,
    [`%"filename":"${filename}"%`],
  ) as unknown as Array<{ id: string; content: string; content_text: string; created_at: string }>;

  if (snapshots.length < 2) return null;

  const newer = snapshots[0];
  const older = snapshots[1];

  let oldVersion = '';
  let newVersion = '';
  try {
    oldVersion = JSON.parse(older.content).version ?? older.created_at.slice(0, 10);
    newVersion = JSON.parse(newer.content).version ?? newer.created_at.slice(0, 10);
  } catch {
    oldVersion = older.created_at.slice(0, 10);
    newVersion = newer.created_at.slice(0, 10);
  }

  const diff = unifiedDiff(older.content_text, newer.content_text, filename);
  return { filename, oldVersion: String(oldVersion), newVersion: String(newVersion), diff };
}

function unifiedDiff(oldText: string, newText: string, filename: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const lines: string[] = [];
  lines.push(`--- ${filename} (old)`);
  lines.push(`+++ ${filename} (new)`);

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  for (const line of oldLines) {
    if (!newSet.has(line)) {
      lines.push(`- ${line}`);
    }
  }
  for (const line of newLines) {
    if (!oldSet.has(line)) {
      lines.push(`+ ${line}`);
    }
  }

  return lines.join('\n');
}

export function getDiffableSpecs(db: Database): string[] {
  const rows = db.all(
    `SELECT content FROM record
     WHERE type = 'spec_snapshot' AND retracted_at IS NULL AND archived_at IS NULL`,
  ) as unknown as Array<{ content: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content);
      if (parsed.filename) {
        counts.set(parsed.filename, (counts.get(parsed.filename) ?? 0) + 1);
      }
    } catch {
      // Skip invalid
    }
  }

  return [...counts.entries()].filter(([, count]) => count >= 2).map(([name]) => name);
}

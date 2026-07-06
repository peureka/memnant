/**
 * Version history — walks version_of chains to show record evolution.
 *
 * Given any record in a version chain, finds all versions
 * and returns them in chronological order (oldest first).
 */

import type { Database } from '../ledger/database.js';

export interface VersionEntry {
  id: string;
  type: string;
  content_text: string;
  created_at: string;
  version: number;
}

export function getVersionHistory(db: Database, recordId: string): VersionEntry[] {
  const record = db.get('SELECT id FROM record WHERE id = ?', [recordId]) as unknown as { id: string } | undefined;
  if (!record) return [];

  // Walk backwards to find the root (oldest version)
  let rootId = recordId;
  const visited = new Set<string>([rootId]);
  while (true) {
    const older = db.get(
      `SELECT target_record_id FROM record_relationship
       WHERE source_record_id = ? AND type = 'version_of' AND dismissed_at IS NULL`,
      [rootId]
    ) as unknown as { target_record_id: string } | undefined;
    if (!older || visited.has(older.target_record_id)) break;
    rootId = older.target_record_id;
    visited.add(rootId);
  }

  // Walk forward from root, collecting the chain
  const chain: VersionEntry[] = [];
  let currentId: string | null = rootId;
  const seen = new Set<string>();
  let version = 1;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const row = db.get(
      'SELECT id, type, content_text, created_at FROM record WHERE id = ?',
      [currentId]
    ) as unknown as { id: string; type: string; content_text: string; created_at: string } | undefined;
    if (!row) break;

    chain.push({
      id: row.id,
      type: row.type,
      content_text: row.content_text,
      created_at: row.created_at,
      version,
    });
    version++;

    const newer = db.get(
      `SELECT source_record_id FROM record_relationship
       WHERE target_record_id = ? AND type = 'version_of' AND dismissed_at IS NULL`,
      [currentId]
    ) as unknown as { source_record_id: string } | undefined;
    currentId = newer?.source_record_id ?? null;
  }

  return chain;
}

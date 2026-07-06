/**
 * memnant — Graph queries and visualization.
 *
 * Story 9.4: Text-based graph visualization, traversal, and formatting.
 */

import type { Database } from '../ledger/database.js';
import type { Relationship } from './relationships.js';

export interface GraphNode {
  id: string;
  short_id: string;
  type: string;
  content_preview: string;
  created_at: string;
  tags: string[];
  connections: Array<{
    target_id: string;
    target_short_id: string;
    relationship_type: string;
    similarity: number;
  }>;
}

interface RecordRow {
  id: string;
  type: string;
  content_text: string;
  created_at: string;
  tags: string;
}

/**
 * Build a graph view for a specific record or the entire ledger.
 */
export function buildGraph(
  db: Database,
  options?: {
    recordId?: string;
    type?: string;
    contradictionsOnly?: boolean;
  },
): GraphNode[] {
  let whereClause = '';
  const params: string[] = [];

  const baseFilter = 'retracted_at IS NULL AND archived_at IS NULL';

  if (options?.recordId) {
    // Get the record and all connected records
    const connectedIds = getConnectedIds(db, options.recordId);
    connectedIds.add(options.recordId);
    const placeholders = Array.from(connectedIds).map(() => '?').join(',');
    whereClause = ` WHERE id IN (${placeholders}) AND ${baseFilter}`;
    params.push(...connectedIds);
  } else if (options?.type) {
    whereClause = ` WHERE type = ? AND ${baseFilter}`;
    params.push(options.type);
  } else {
    whereClause = ` WHERE ${baseFilter}`;
  }

  const records = db.all(
    `SELECT id, type, content_text, created_at, tags FROM record${whereClause} ORDER BY created_at DESC`,
    params,
  ) as unknown as RecordRow[];

  if (records.length === 0) return [];

  // Batch-fetch all relationships for the fetched records in a single query
  const recordIds = records.map((r) => r.id);
  const placeholders = recordIds.map(() => '?').join(',');
  const allRelationships = db.all(
    `SELECT * FROM record_relationship
     WHERE (source_record_id IN (${placeholders}) OR target_record_id IN (${placeholders})) AND dismissed_at IS NULL`,
    [...recordIds, ...recordIds],
  ) as unknown as Relationship[];

  // Group relationships by record ID
  const relationshipsByRecord = new Map<string, Relationship[]>();
  for (const id of recordIds) {
    relationshipsByRecord.set(id, []);
  }
  for (const rel of allRelationships) {
    relationshipsByRecord.get(rel.source_record_id)?.push(rel);
    if (rel.source_record_id !== rel.target_record_id) {
      relationshipsByRecord.get(rel.target_record_id)?.push(rel);
    }
  }

  const nodes: GraphNode[] = [];

  for (const record of records) {
    const relationships = relationshipsByRecord.get(record.id) ?? [];

    if (options?.contradictionsOnly) {
      const hasContradiction = relationships.some((r) => r.type === 'contradicts');
      if (!hasContradiction) continue;
    }

    const connections = relationships.map((r) => {
      const targetId = r.source_record_id === record.id ? r.target_record_id : r.source_record_id;
      return {
        target_id: targetId,
        target_short_id: targetId.slice(0, 8),
        relationship_type: r.type,
        similarity: Math.round(r.similarity * 1000) / 1000,
      };
    });

    nodes.push({
      id: record.id,
      short_id: record.id.slice(0, 8),
      type: record.type,
      content_preview: record.content_text.split('\n')[0].slice(0, 100),
      created_at: record.created_at,
      tags: JSON.parse(record.tags),
      connections,
    });
  }

  return nodes;
}

/**
 * Format graph as text tree.
 */
export function formatGraphAsText(nodes: GraphNode[]): string {
  if (nodes.length === 0) return 'No records found.';

  const lines: string[] = [];

  for (const node of nodes) {
    const date = node.created_at.slice(0, 10);
    const tagsStr = node.tags.length > 0 ? ` [${node.tags.join(', ')}]` : '';
    lines.push(`[${node.short_id}] ${node.type}: ${node.content_preview}${tagsStr} (${date})`);

    for (const conn of node.connections) {
      const arrow = conn.relationship_type === 'supersedes' ? '>>>'
        : conn.relationship_type === 'contradicts' ? '!!!'
        : '---';
      lines.push(`  ${arrow} [${conn.target_short_id}] (${conn.relationship_type}, ${conn.similarity})`);
    }
  }

  return lines.join('\n');
}

/**
 * Get all record IDs connected to a given record (1 hop).
 */
function getConnectedIds(db: Database, recordId: string): Set<string> {
  const rows = db.all(
    `SELECT source_record_id, target_record_id FROM record_relationship
     WHERE (source_record_id = ? OR target_record_id = ?) AND dismissed_at IS NULL`,
    [recordId, recordId],
  ) as unknown as Array<{ source_record_id: string; target_record_id: string }>;

  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.source_record_id);
    ids.add(row.target_record_id);
  }
  ids.delete(recordId);
  return ids;
}

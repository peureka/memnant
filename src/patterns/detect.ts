/**
 * Pattern detection — discovers recurring themes across records.
 */

import type { ClusterInput } from './cluster.js';
import { clusterRecords } from './cluster.js';
import { summarizeClusterTemplate, summarizeClusterLlm } from './summarize.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { serializeEmbedding, deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';
import { insertRecord } from '../ledger/records.js';

const CLUSTER_THRESHOLD = 0.82;
const PATTERN_MATCH_THRESHOLD = 0.92;

export interface PatternResult {
  patternsCreated: number;
  patternsUpdated: number;
  clustersFound: number;
}

function gatherRecords(db: any, types: string[]): ClusterInput[] {
  const placeholders = types.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT id, project_id, type, content_text, tags, embedding
     FROM record
     WHERE type IN (${placeholders})
       AND embedding IS NOT NULL
       AND retracted_at IS NULL
       AND archived_at IS NULL`,
    types
  );

  return rows.map((r: any) => ({
    id: r.id,
    project_id: r.project_id,
    type: r.type,
    content_text: r.content_text,
    tags: JSON.parse(r.tags),
    embedding: deserializeEmbedding(r.embedding),
  }));
}

interface ExistingPattern {
  id: string;
  embedding: Float32Array;
  pattern_strength: number;
  supporting_records: string;
}

function getExistingPatterns(colonyDb: any): ExistingPattern[] {
  const rows = colonyDb.all(
    "SELECT id, embedding, pattern_strength, supporting_records FROM record WHERE type = 'pattern' AND embedding IS NOT NULL AND retracted_at IS NULL"
  );
  return rows.map((r: any) => ({
    id: r.id,
    embedding: deserializeEmbedding(r.embedding),
    pattern_strength: r.pattern_strength ?? 0,
    supporting_records: r.supporting_records ?? '[]',
  }));
}

function findMatchingPattern(
  clusterEmbedding: Float32Array,
  existing: ExistingPattern[],
): ExistingPattern | null {
  for (const p of existing) {
    if (dotProduct(clusterEmbedding, p.embedding) >= PATTERN_MATCH_THRESHOLD) {
      return p;
    }
  }
  return null;
}

export async function detectPatterns(
  projectDb: any,
  colonyDb: any,
  options?: { tierConfig?: any },
): Promise<PatternResult> {
  const projectRecords = gatherRecords(projectDb, ['decision', 'framework_fix']);
  const colonyRecords = gatherRecords(colonyDb, ['decision', 'framework_fix']);
  const allRecords = [...projectRecords, ...colonyRecords];

  if (allRecords.length < 3) {
    return { patternsCreated: 0, patternsUpdated: 0, clustersFound: 0 };
  }

  const clusters = clusterRecords(allRecords, CLUSTER_THRESHOLD);

  if (clusters.length === 0) {
    return { patternsCreated: 0, patternsUpdated: 0, clustersFound: 0 };
  }

  const existingPatterns = getExistingPatterns(colonyDb);
  let patternsCreated = 0;
  let patternsUpdated = 0;

  for (const cluster of clusters) {
    const clusterEmbedding = await generateEmbedding(cluster.centroidText);
    const supportingRecords = cluster.records.map(r => ({
      project_id: r.project_id,
      record_id: r.id,
    }));

    const match = findMatchingPattern(clusterEmbedding, existingPatterns);

    if (match) {
      const existingSupporting = JSON.parse(match.supporting_records) as Array<{ project_id: string; record_id: string }>;
      const existingIds = new Set(existingSupporting.map(s => s.record_id));
      const merged = [...existingSupporting];
      for (const sr of supportingRecords) {
        if (!existingIds.has(sr.record_id)) {
          merged.push(sr);
        }
      }

      colonyDb.run(
        "UPDATE record SET pattern_strength = ?, pattern_last_seen = ?, supporting_records = ? WHERE id = ?",
        [merged.length, new Date().toISOString(), JSON.stringify(merged), match.id]
      );
      patternsUpdated++;
    } else {
      let summary: string;
      if (options?.tierConfig) {
        try {
          summary = await summarizeClusterLlm(cluster, options.tierConfig);
        } catch {
          summary = summarizeClusterTemplate(cluster);
        }
      } else {
        summary = summarizeClusterTemplate(cluster);
      }

      const embeddingBuffer = serializeEmbedding(clusterEmbedding);
      insertRecord(colonyDb, {
        projectId: 'colony',
        type: 'pattern' as any,
        contentText: summary,
        embedding: embeddingBuffer,
        tags: cluster.tags,
      });

      // Set pattern-specific fields
      const inserted = colonyDb.get(
        "SELECT id FROM record WHERE type = 'pattern' ORDER BY created_at DESC LIMIT 1"
      ) as any;
      if (inserted) {
        colonyDb.run(
          "UPDATE record SET pattern_strength = ?, pattern_last_seen = ?, supporting_records = ? WHERE id = ?",
          [supportingRecords.length, new Date().toISOString(), JSON.stringify(supportingRecords), inserted.id]
        );
      }

      patternsCreated++;
    }
  }

  return { patternsCreated, patternsUpdated, clustersFound: clusters.length };
}

/**
 * memnant — Pattern detection across records.
 *
 * Story 11.2: Cluster records by topic, summarize clusters with 3+ records.
 * Uses tag-based grouping first, then embedding-based greedy clustering.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig, TierConfig } from '../types.js';
import { deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';
import { callModel } from '../orchestrator/providers.js';

export interface PatternCluster {
  topic: string;
  record_count: number;
  records: Array<{
    id: string;
    short_id: string;
    type: string;
    content_preview: string;
  }>;
  summary?: string;
}

interface RecordRow {
  id: string;
  type: string;
  content_text: string;
  tags: string;
  embedding: Uint8Array | null;
}

const CLUSTER_SIMILARITY_THRESHOLD = 0.65;
const MIN_CLUSTER_SIZE = 3;

/**
 * Detect patterns by clustering records.
 */
export async function detectPatterns(
  db: Database,
  config: ProjectConfig,
): Promise<PatternCluster[]> {
  const records = db.all(
    "SELECT id, type, content_text, tags, embedding FROM record WHERE type IN ('decision', 'framework_fix') AND retracted_at IS NULL AND archived_at IS NULL ORDER BY created_at DESC",
  ) as unknown as RecordRow[];

  if (records.length === 0) return [];

  // Step 1: Tag-based grouping
  const tagClusters = clusterByTags(records);

  // Step 2: Embedding-based clustering for untagged/remaining records
  const clusteredIds = new Set(tagClusters.flatMap((c) => c.records.map((r) => r.id)));
  const unclustered = records.filter((r) => !clusteredIds.has(r.id) && r.embedding);
  const embeddingClusters = clusterByEmbedding(unclustered);

  const allClusters = [...tagClusters, ...embeddingClusters]
    .filter((c) => c.record_count >= MIN_CLUSTER_SIZE);

  // Step 3: LLM summaries for each cluster
  for (const cluster of allClusters) {
    try {
      cluster.summary = await summarizeCluster(cluster, config.orchestrator.tiers.analysis);
    } catch {
      // Skip summary if LLM unavailable
    }
  }

  return allClusters;
}

function clusterByTags(records: RecordRow[]): PatternCluster[] {
  const tagGroups = new Map<string, RecordRow[]>();

  for (const record of records) {
    const tags: string[] = JSON.parse(record.tags);
    for (const tag of tags) {
      if (!tagGroups.has(tag)) {
        tagGroups.set(tag, []);
      }
      tagGroups.get(tag)!.push(record);
    }
  }

  return Array.from(tagGroups.entries()).map(([tag, recs]) => ({
    topic: tag,
    record_count: recs.length,
    records: recs.map((r) => ({
      id: r.id,
      short_id: r.id.slice(0, 8),
      type: r.type,
      content_preview: r.content_text.split('\n')[0].slice(0, 100),
    })),
  }));
}

function clusterByEmbedding(records: RecordRow[]): PatternCluster[] {
  if (records.length === 0) return [];

  const clusters: PatternCluster[] = [];
  const assigned = new Set<string>();

  // Precompute embeddings
  const embeddings = new Map<string, Float32Array>();
  for (const r of records) {
    if (r.embedding) {
      embeddings.set(r.id, deserializeEmbedding(r.embedding));
    }
  }

  // Greedy clustering: pick unassigned record, find similar unassigned records
  for (const record of records) {
    if (assigned.has(record.id)) continue;
    const seedEmbedding = embeddings.get(record.id);
    if (!seedEmbedding) continue;

    const cluster: RecordRow[] = [record];
    assigned.add(record.id);

    for (const other of records) {
      if (assigned.has(other.id)) continue;
      const otherEmbedding = embeddings.get(other.id);
      if (!otherEmbedding) continue;

      const similarity = dotProduct(seedEmbedding, otherEmbedding);
      if (similarity >= CLUSTER_SIMILARITY_THRESHOLD) {
        cluster.push(other);
        assigned.add(other.id);
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      // Generate topic from first record's content
      const topic = record.content_text.split('\n')[0].slice(0, 50).trim();

      clusters.push({
        topic,
        record_count: cluster.length,
        records: cluster.map((r) => ({
          id: r.id,
          short_id: r.id.slice(0, 8),
          type: r.type,
          content_preview: r.content_text.split('\n')[0].slice(0, 100),
        })),
      });
    }
  }

  return clusters;
}

async function summarizeCluster(
  cluster: PatternCluster,
  tierConfig: TierConfig,
): Promise<string> {
  const records = cluster.records
    .map((r) => `- [${r.short_id}] ${r.type}: ${r.content_preview}`)
    .join('\n');

  const response = await callModel(
    tierConfig,
    'Summarize this cluster of project records in one sentence. Be specific about the pattern.',
    `Topic: ${cluster.topic}\nRecords (${cluster.record_count}):\n${records}`,
  );

  return response.text.trim();
}

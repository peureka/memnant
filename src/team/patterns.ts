/**
 * memnant — Team pattern analysis.
 *
 * Story 15.3b: Cross-builder consensus and divergence detection
 * with coverage indicator.
 */

import type { Database } from '../ledger/database.js';
import { deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';

const CONSENSUS_THRESHOLD = 0.85;

export interface TeamPatternResult {
  consensus: Array<{ topic: string; builders: string[] }>;
  divergent: Array<{ topic: string; positions: Array<{ builder: string; stance: string }> }>;
}

export interface TeamCoverage {
  activeBuilders: number;
  totalBuilders: number;
  builderNames: string[];
}

interface RecordWithBuilder {
  id: string;
  type: string;
  content_text: string;
  builder_id: string;
  embedding: Float32Array;
}

function getBuilderRecords(db: Database): RecordWithBuilder[] {
  const rows = db.all(
    `SELECT id, type, content_text, builder_id, embedding FROM record
     WHERE builder_id IS NOT NULL AND embedding IS NOT NULL
       AND type IN ('decision', 'framework_fix')
       AND retracted_at IS NULL AND archived_at IS NULL
       AND created_at > datetime('now', '-30 days')`
  ) as any[];

  return rows.map((r: any) => ({
    id: r.id,
    type: r.type,
    content_text: r.content_text,
    builder_id: r.builder_id,
    embedding: deserializeEmbedding(r.embedding),
  }));
}

export function analyzeTeamPatterns(db: Database): TeamPatternResult {
  const records = getBuilderRecords(db);
  if (records.length < 2) return { consensus: [], divergent: [] };

  const consensus: TeamPatternResult['consensus'] = [];
  const divergent: TeamPatternResult['divergent'] = [];
  const processed = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    if (processed.has(records[i].id)) continue;

    const cluster: RecordWithBuilder[] = [records[i]];
    for (let j = i + 1; j < records.length; j++) {
      if (processed.has(records[j].id)) continue;
      const sim = dotProduct(records[i].embedding, records[j].embedding);
      if (sim >= CONSENSUS_THRESHOLD) {
        cluster.push(records[j]);
        processed.add(records[j].id);
      }
    }

    if (cluster.length < 2) continue;
    processed.add(records[i].id);

    const builders = [...new Set(cluster.map(r => r.builder_id))];
    const topic = cluster[0].content_text.split('\n')[0].slice(0, 100);

    if (builders.length >= 2) {
      const clusterIds = cluster.map(r => r.id);
      const placeholders = clusterIds.map(() => '?').join(',');
      const hasContradiction = db.get(
        `SELECT 1 FROM record_relationship
         WHERE type = 'contradicts' AND dismissed_at IS NULL
           AND source_record_id IN (${placeholders})
           AND target_record_id IN (${placeholders})`,
        [...clusterIds, ...clusterIds]
      );

      if (hasContradiction) {
        divergent.push({
          topic,
          positions: cluster.map(r => ({
            builder: r.builder_id,
            stance: r.content_text.split('\n')[0].slice(0, 100),
          })),
        });
      } else {
        consensus.push({ topic, builders });
      }
    }
  }

  return { consensus, divergent };
}

export function getTeamCoverage(db: Database): TeamCoverage {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const active = db.all(
    `SELECT DISTINCT builder_id FROM record
     WHERE builder_id IS NOT NULL AND created_at > ?
       AND retracted_at IS NULL AND archived_at IS NULL`,
    [thirtyDaysAgo]
  ) as any[];

  const total = db.all(
    `SELECT DISTINCT builder_id FROM record WHERE builder_id IS NOT NULL`
  ) as any[];

  return {
    activeBuilders: active.length,
    totalBuilders: total.length,
    builderNames: active.map((r: any) => r.builder_id),
  };
}

export function formatTeamPatterns(
  patterns: TeamPatternResult,
  coverage: TeamCoverage,
): string {
  const lines: string[] = [];

  if (patterns.consensus.length > 0) {
    lines.push('Consensus:');
    for (const c of patterns.consensus) {
      lines.push(`  ${c.topic} (${c.builders.join(', ')})`);
    }
    lines.push('');
  }

  if (patterns.divergent.length > 0) {
    lines.push('Divergent:');
    for (const d of patterns.divergent) {
      lines.push(`  ${d.topic}`);
      for (const p of d.positions) {
        lines.push(`    ${p.builder}: ${p.stance}`);
      }
    }
    lines.push('');
  }

  if (patterns.consensus.length === 0 && patterns.divergent.length === 0) {
    lines.push('No cross-builder patterns found in the last 30 days.');
    lines.push('');
  }

  lines.push(`Coverage: ${coverage.activeBuilders}/${coverage.totalBuilders} active builders.`);

  return lines.join('\n');
}

/**
 * memnant — Decision churn metrics.
 * Finds topics where decisions have been superseded 3+ times.
 */

import type { Database } from '../ledger/database.js';

export interface ChurnMetric {
  headRecordId: string;
  contentPreview: string;
  supersessionCount: number;
  chainIds: string[];
}

export function computeChurnMetrics(db: Database, minChurn: number = 3): ChurnMetric[] {
  // Find heads of supersession chains: records that supersede others
  // but are NOT themselves superseded by anyone
  const heads = db.all(
    `SELECT DISTINCT r.id, r.content_text FROM record r
     JOIN record_relationship rr_source ON (rr_source.source_record_id = r.id AND rr_source.type = 'supersedes' AND rr_source.dismissed_at IS NULL)
     LEFT JOIN record_relationship rr_target ON (rr_target.target_record_id = r.id AND rr_target.type = 'supersedes' AND rr_target.dismissed_at IS NULL)
     WHERE r.retracted_at IS NULL AND r.archived_at IS NULL
       AND rr_target.id IS NULL`,
  ) as unknown as Array<{ id: string; content_text: string }>;

  const results: ChurnMetric[] = [];
  for (const head of heads) {
    const chain: string[] = [head.id];
    let currentId = head.id;
    const visited = new Set<string>([currentId]);

    // Walk the supersession chain downward (head supersedes → target supersedes → ...)
    while (true) {
      const rel = db.get(
        `SELECT target_record_id FROM record_relationship
         WHERE source_record_id = ? AND type = 'supersedes' AND dismissed_at IS NULL`,
        [currentId],
      ) as unknown as { target_record_id: string } | undefined;

      if (!rel || visited.has(rel.target_record_id)) break;
      visited.add(rel.target_record_id);
      chain.push(rel.target_record_id);
      currentId = rel.target_record_id;
    }

    // supersessionCount is the number of supersedes relationships = chain.length - 1
    // But the spec says "superseded 3+ times" meaning 3+ supersessions in the chain
    if (chain.length - 1 >= minChurn) {
      results.push({
        headRecordId: head.id,
        contentPreview: (head.content_text || '').split('\n')[0].slice(0, 100),
        supersessionCount: chain.length - 1,
        chainIds: chain,
      });
    }
  }

  results.sort((a, b) => b.supersessionCount - a.supersessionCount);
  return results;
}

export function formatChurnAlerts(metrics: ChurnMetric[]): string[] {
  return metrics.map(m =>
    `[churn \u00b7 ${m.supersessionCount}x] "${m.contentPreview}" \u2014 revisited ${m.supersessionCount} times. Consider resolving the underlying tension.`
  );
}

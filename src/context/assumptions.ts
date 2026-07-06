/**
 * Assumption surfacing — groups active assumptions from decisions.
 *
 * Queries decisions with non-null assumptions, groups by assumption text,
 * and returns which decisions depend on each assumption.
 */

import type { Database } from '../ledger/database.js';

export interface ActiveAssumption {
  assumption: string;
  decisions: Array<{
    id: string;
    content_text: string;
  }>;
}

export function getActiveAssumptions(
  db: Database,
  projectId: string,
): ActiveAssumption[] {
  const rows = db.all(
    `SELECT id, content_text, assumptions
     FROM record
     WHERE project_id = ?
       AND type = 'decision'
       AND assumptions IS NOT NULL
       AND retracted_at IS NULL
       AND archived_at IS NULL`,
    [projectId]
  ) as any[];

  const assumptionMap = new Map<string, Array<{ id: string; content_text: string }>>();

  for (const row of rows) {
    let parsed: string[];
    try {
      parsed = JSON.parse(row.assumptions);
      if (!Array.isArray(parsed)) continue;
    } catch {
      continue;
    }

    for (const assumption of parsed) {
      if (!assumptionMap.has(assumption)) {
        assumptionMap.set(assumption, []);
      }
      assumptionMap.get(assumption)!.push({
        id: row.id,
        content_text: row.content_text,
      });
    }
  }

  return Array.from(assumptionMap.entries())
    .map(([assumption, decisions]) => ({ assumption, decisions }))
    .sort((a, b) => b.decisions.length - a.decisions.length);
}

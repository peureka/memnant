/**
 * memnant — Governance override tracking.
 *
 * Story 14.3: When --force overrides violations, log a governance_override record.
 * After 3 overrides of the same rule, surface suggestion at session start.
 */

import type { Database } from '../ledger/database.js';

export interface OverrideSummary {
  rule: string;
  count: number;
  last_override: string;
}

/**
 * Get rules that have been overridden 3+ times.
 * Returns suggestions for session context.
 */
export function getOverrideSuggestions(db: Database): string[] {
  const rows = db.all(
    `SELECT content_text, COUNT(*) as count
     FROM record
     WHERE type = 'governance_override'
     GROUP BY content_text
     HAVING COUNT(*) >= 3
     ORDER BY count DESC
     LIMIT 5`,
  ) as unknown as Array<{ content_text: string; count: number }>;

  return rows.map((r) => {
    const firstLine = r.content_text.split('\n')[0].slice(0, 150);
    return `Rule overridden ${r.count}x: ${firstLine}. Consider updating the spec or fixing the code.`;
  });
}

/**
 * Get a summary of all governance overrides.
 */
export function getOverrideSummary(db: Database): OverrideSummary[] {
  const rows = db.all(
    `SELECT content_text, COUNT(*) as count, MAX(created_at) as last_override
     FROM record
     WHERE type = 'governance_override'
     GROUP BY content_text
     ORDER BY count DESC`,
  ) as unknown as Array<{ content_text: string; count: number; last_override: string }>;

  return rows.map((r) => ({
    rule: r.content_text.split('\n')[0].slice(0, 200),
    count: r.count,
    last_override: r.last_override,
  }));
}

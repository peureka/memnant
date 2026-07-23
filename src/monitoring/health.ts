/**
 * memnant — Health monitoring.
 *
 * Story 13.1: Gathers project health stats and computes a health score.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig } from '../types.js';
import { getUnresolvedContradictions } from '../graph/relationships.js';
import { getLastSnapshotDate } from '../snapshot/scanner.js';
import { computeLiveStaleRecordIds } from '../context/compile.js';

export type HealthStatus = 'healthy' | 'attention' | 'critical';

export interface HealthReport {
  status: HealthStatus;
  project_name: string;
  record_count: number;
  session_count: number;
  days_since_last_session: number | null;
  days_since_last_snapshot: number | null;
  unresolved_contradictions: number;
  stale_count: number;
  record_growth_7d: number;
  issues: string[];
}

/**
 * Gather health report for the project.
 */
export async function gatherHealth(
  db: Database,
  config: ProjectConfig,
  projectRoot: string,
): Promise<HealthReport> {
  const issues: string[] = [];

  // Record count
  const recordRow = db.get(
    'SELECT COUNT(*) as count FROM record',
  ) as unknown as { count: number };
  const recordCount = recordRow.count;

  // Session count
  const sessionRow = db.get(
    'SELECT COUNT(*) as count FROM session',
  ) as unknown as { count: number };
  const sessionCount = sessionRow.count;

  // Days since last session
  const lastSessionRow = db.get(
    'SELECT closed_at FROM session WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1',
  ) as unknown as { closed_at: string } | undefined;

  let daysSinceLastSession: number | null = null;
  if (lastSessionRow) {
    daysSinceLastSession = Math.floor(
      (Date.now() - new Date(lastSessionRow.closed_at).getTime()) / (1000 * 60 * 60 * 24),
    );
  }

  // Days since last snapshot
  const lastSnapshotDate = getLastSnapshotDate(db);
  let daysSinceLastSnapshot: number | null = null;
  if (lastSnapshotDate) {
    daysSinceLastSnapshot = Math.floor(
      (Date.now() - new Date(lastSnapshotDate).getTime()) / (1000 * 60 * 60 * 24),
    );
  }

  // Unresolved contradictions
  const contradictions = getUnresolvedContradictions(db);

  // Stale count from the LIVE staleness path (file-hash + AST + semantic), the
  // same source recall/stats use. The old staleness_marker column was never
  // written; querying it always returned 0. Degrades to 0 with no snapshot.
  const staleCount = (await computeLiveStaleRecordIds(db, projectRoot)).size;

  // Record growth in last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const growthRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE created_at > ?',
    [weekAgo],
  ) as unknown as { count: number };

  // Compute issues
  if (staleCount > 5) {
    issues.push(`${staleCount} stale records — run \`memnant snapshot\` and review`);
  } else if (staleCount > 0) {
    issues.push(`${staleCount} stale record(s) — consider reviewing`);
  }

  if (contradictions.length > 0) {
    issues.push(`${contradictions.length} unresolved contradiction(s)`);
  }

  if (daysSinceLastSession !== null && daysSinceLastSession > 30) {
    issues.push(`No session in ${daysSinceLastSession} days`);
  }

  if (daysSinceLastSnapshot !== null && daysSinceLastSnapshot > 7) {
    issues.push(`Snapshot is ${daysSinceLastSnapshot} days old`);
  } else if (daysSinceLastSnapshot === null && recordCount > 0) {
    issues.push('No codebase snapshot — run `memnant snapshot`');
  }

  // Compute status
  let status: HealthStatus = 'healthy';
  if (staleCount > 5 || (daysSinceLastSession !== null && daysSinceLastSession > 30)) {
    status = 'critical';
  } else if (staleCount > 0 || contradictions.length > 0 || (daysSinceLastSnapshot !== null && daysSinceLastSnapshot > 7)) {
    status = 'attention';
  }

  return {
    status,
    project_name: config.project.name,
    record_count: recordCount,
    session_count: sessionCount,
    days_since_last_session: daysSinceLastSession,
    days_since_last_snapshot: daysSinceLastSnapshot,
    unresolved_contradictions: contradictions.length,
    stale_count: staleCount,
    record_growth_7d: growthRow.count,
    issues,
  };
}

/**
 * Format health report as text for CLI output.
 */
export function formatHealthReport(report: HealthReport): string {
  const statusIcon = report.status === 'healthy' ? 'OK' : report.status === 'attention' ? '!!' : 'XX';
  const parts: string[] = [];

  parts.push(`[${statusIcon}] ${report.project_name} — ${report.status}`);
  parts.push('');
  parts.push(`Records: ${report.record_count} (${report.record_growth_7d} in last 7d)`);
  parts.push(`Sessions: ${report.session_count}`);

  if (report.days_since_last_session !== null) {
    parts.push(`Last session: ${report.days_since_last_session}d ago`);
  } else {
    parts.push('Last session: never');
  }

  if (report.days_since_last_snapshot !== null) {
    parts.push(`Last snapshot: ${report.days_since_last_snapshot}d ago`);
  } else {
    parts.push('Last snapshot: never');
  }

  parts.push(`Stale records: ${report.stale_count}`);
  parts.push(`Contradictions: ${report.unresolved_contradictions}`);

  if (report.issues.length > 0) {
    parts.push('');
    parts.push('Issues:');
    for (const issue of report.issues) {
      parts.push(`  - ${issue}`);
    }
  }

  return parts.join('\n');
}

/**
 * Ledger analytics — knowledge health metrics.
 *
 * Computes decision velocity, knowledge area distribution,
 * coverage gaps, assumption load, and review pressure.
 */

export interface WeeklyCount {
  week: string;
  count: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface CoverageGaps {
  forgottenDecisions: number;
  forgottenFiles: string[];
  undocumentedAreas: number;
  undocumentedFiles: string[];
}

export interface AnalyticsReport {
  velocity: {
    weeks: WeeklyCount[];
    total: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    trendPercent: number;
  };
  knowledgeAreas: TagCount[];
  coverageGaps: CoverageGaps;
  assumptionCount: number;
  topAssumption: string | null;
  topAssumptionDecisions: number;
  reviewPressureCount: number;
  churn: import('./churn.js').ChurnMetric[];
}

function getISOWeek(date: Date): number {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

export async function computeAnalytics(
  db: any,
  projectId: string,
): Promise<AnalyticsReport> {
  const now = new Date();
  const eightWeeksAgo = new Date(now.getTime() - 8 * 7 * 24 * 60 * 60 * 1000);

  // Decision velocity — records per week (last 8 weeks)
  const recentRecords = db.all(
    `SELECT created_at FROM record
     WHERE project_id = ? AND retracted_at IS NULL AND archived_at IS NULL
       AND created_at >= ?
     ORDER BY created_at ASC`,
    [projectId, eightWeeksAgo.toISOString()]
  ) as any[];

  // Build week buckets
  const weekCounts = new Map<string, number>();
  for (let i = 0; i < 8; i++) {
    const weekDate = new Date(now.getTime() - (7 - i) * 7 * 24 * 60 * 60 * 1000);
    const weekNum = getISOWeek(weekDate);
    const label = `W${String(weekNum).padStart(2, '0')}`;
    weekCounts.set(label, 0);
  }

  for (const row of recentRecords) {
    const d = new Date(row.created_at);
    const weekNum = getISOWeek(d);
    const label = `W${String(weekNum).padStart(2, '0')}`;
    if (weekCounts.has(label)) {
      weekCounts.set(label, (weekCounts.get(label) ?? 0) + 1);
    }
  }

  const weeks: WeeklyCount[] = Array.from(weekCounts.entries()).map(([week, count]) => ({ week, count }));
  const total = recentRecords.length;

  // Trend: compare first 4 weeks vs last 4 weeks
  const weekValues = weeks.map(w => w.count);
  const firstHalf = weekValues.slice(0, 4).reduce((a, b) => a + b, 0);
  const secondHalf = weekValues.slice(4).reduce((a, b) => a + b, 0);
  let trend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  let trendPercent = 0;
  if (firstHalf > 0) {
    trendPercent = Math.round(((secondHalf - firstHalf) / firstHalf) * 100);
    if (trendPercent > 10) trend = 'increasing';
    else if (trendPercent < -10) trend = 'decreasing';
  } else if (secondHalf > 0) {
    trend = 'increasing';
    trendPercent = 100;
  }

  // Knowledge area distribution — tag frequency
  const allTags = db.all(
    `SELECT tags FROM record
     WHERE project_id = ? AND retracted_at IS NULL AND archived_at IS NULL`,
    [projectId]
  ) as any[];

  const tagMap = new Map<string, number>();
  for (const row of allTags) {
    try {
      const tags: string[] = JSON.parse(row.tags);
      for (const tag of tags) {
        if (tag) tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
      }
    } catch { /* skip bad tags */ }
  }

  const knowledgeAreas: TagCount[] = Array.from(tagMap.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Coverage gaps
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Forgotten decisions: anchored to files, no access in 60 days
  const forgottenRows = db.all(
    `SELECT DISTINCT r.target_file FROM record r
     WHERE r.project_id = ? AND r.target_file IS NOT NULL
       AND r.type = 'decision'
       AND r.retracted_at IS NULL AND r.archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM record_access ra WHERE ra.record_id = r.id AND ra.accessed_at >= ?
       )`,
    [projectId, sixtyDaysAgo]
  ) as any[];

  const forgottenFiles = forgottenRows.map((r: any) => r.target_file);

  // Undocumented areas: files in recent record_access context that look like file paths but have no anchored records
  const accessedFiles = db.all(
    `SELECT DISTINCT ra.context as file FROM record_access ra
     WHERE ra.accessed_at >= ?
       AND ra.context LIKE '%.%'`,
    [sixtyDaysAgo]
  ) as any[];

  const anchoredFiles = new Set(
    (db.all(
      `SELECT DISTINCT target_file FROM record
       WHERE project_id = ? AND target_file IS NOT NULL
         AND retracted_at IS NULL AND archived_at IS NULL`,
      [projectId]
    ) as any[]).map((r: any) => r.target_file)
  );

  const undocumentedFiles = accessedFiles
    .map((r: any) => r.file)
    .filter((f: string) => !anchoredFiles.has(f));

  // Assumption load (reuse M13)
  let assumptionCount = 0;
  let topAssumption: string | null = null;
  let topAssumptionDecisions = 0;
  try {
    const { getActiveAssumptions } = await import('../context/assumptions.js');
    const assumptions = getActiveAssumptions(db, projectId);
    assumptionCount = assumptions.length;
    if (assumptions.length > 0) {
      topAssumption = assumptions[0].assumption;
      topAssumptionDecisions = assumptions[0].decisions.length;
    }
  } catch { /* best-effort */ }

  // Review pressure (reuse M13)
  let reviewPressureCount = 0;
  try {
    const { findDecisionsDueForReview } = await import('../relevance/review-pressure.js');
    const candidates = findDecisionsDueForReview(db, projectId, 90);
    reviewPressureCount = candidates.length;
  } catch { /* best-effort */ }

  // Decision churn (Epic 19)
  let churn: import('./churn.js').ChurnMetric[] = [];
  try {
    const { computeChurnMetrics } = await import('./churn.js');
    churn = computeChurnMetrics(db);
  } catch { /* best-effort */ }

  return {
    velocity: { weeks, total, trend, trendPercent },
    knowledgeAreas,
    coverageGaps: {
      forgottenDecisions: forgottenFiles.length,
      forgottenFiles,
      undocumentedAreas: undocumentedFiles.length,
      undocumentedFiles,
    },
    assumptionCount,
    topAssumption,
    topAssumptionDecisions,
    reviewPressureCount,
    churn,
  };
}

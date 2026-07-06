/**
 * memnant — Ledger statistics.
 *
 * Aggregates counts, age, graph, and health metrics from the ledger.
 */

import type { Database } from './database.js';
import { MODEL_NAME } from '../vector/embedding-utils.js';

export interface LedgerStats {
  records: {
    total: number;
    active: number;
    byType: { [type: string]: number };
    retracted: number;
    archived: number;
  };
  sessions: {
    total: number;
    lastSessionAt: string | null;
  };
  staleness: {
    staleCount: number;
  };
  contradictions: {
    unresolvedCount: number;
  };
  graph: {
    connectionCount: number;
  };
  age: {
    oldestRecord: string | null;
    newestRecord: string | null;
  };
  embeddings: {
    currentModel: string;
    totalWithEmbeddings: number;
    mismatchedCount: number;
  };
  contextEvents: {
    totalEvents: number;
    avgTokensPerSession: number;
  };
  mostConnected: {
    id: string;
    short_id: string;
    type: string;
    contentPreview: string;
    connectionCount: number;
  } | null;
  engagement: {
    sessionNumber: number;
    avgDaysBetween: number | null;
    medianDaysBetween: number | null;
    timeToSession3Days: number | null;
    currentStreakWeeks: number;
    longestGapDays: number | null;
    sessionsPerMonth: Array<{ month: string; count: number }>;
  };
}

export function getLedgerStats(db: Database): LedgerStats {
  // Total records (all, including retracted/archived)
  const totalRow = db.get('SELECT COUNT(*) as count FROM record') as unknown as { count: number };
  const total = totalRow.count;

  // Active records (not retracted or archived)
  const activeRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE retracted_at IS NULL AND archived_at IS NULL',
  ) as unknown as { count: number };
  const active = activeRow.count;

  // By type (active only)
  const typeRows = db.all(
    "SELECT type, COUNT(*) as count FROM record WHERE retracted_at IS NULL AND archived_at IS NULL GROUP BY type ORDER BY count DESC",
  ) as unknown as Array<{ type: string; count: number }>;
  const byType: { [type: string]: number } = {};
  for (const row of typeRows) {
    byType[row.type] = row.count;
  }

  // Retracted count
  const retractedRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE retracted_at IS NOT NULL',
  ) as unknown as { count: number };

  // Archived count
  const archivedRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE archived_at IS NOT NULL',
  ) as unknown as { count: number };

  // Sessions
  const sessionRow = db.get('SELECT COUNT(*) as count FROM session') as unknown as { count: number };
  const lastSessionRow = db.get(
    'SELECT started_at FROM session ORDER BY started_at DESC LIMIT 1',
  ) as unknown as { started_at: string } | undefined;

  // Stale count (records with staleness_marker set, active only)
  const staleRow = db.get(
    "SELECT COUNT(*) as count FROM record WHERE staleness_marker IS NOT NULL AND staleness_marker != '{}' AND retracted_at IS NULL AND archived_at IS NULL",
  ) as unknown as { count: number };

  // Unresolved contradictions
  const contradictionRow = db.get(
    "SELECT COUNT(*) as count FROM record_relationship WHERE type = 'contradicts' AND dismissed_at IS NULL",
  ) as unknown as { count: number };

  // Graph connections (active, not dismissed)
  const connectionRow = db.get(
    'SELECT COUNT(*) as count FROM record_relationship WHERE dismissed_at IS NULL',
  ) as unknown as { count: number };

  // Age stats
  const oldestRow = db.get(
    'SELECT created_at FROM record WHERE retracted_at IS NULL AND archived_at IS NULL ORDER BY created_at ASC LIMIT 1',
  ) as unknown as { created_at: string } | undefined;
  const newestRow = db.get(
    'SELECT created_at FROM record WHERE retracted_at IS NULL AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1',
  ) as unknown as { created_at: string } | undefined;

  // Most connected record
  let mostConnected: LedgerStats['mostConnected'] = null;
  const mcRow = db.get(
    `SELECT r.id, r.type, r.content_text, COUNT(*) as conn_count
     FROM record r
     JOIN record_relationship rr ON (rr.source_record_id = r.id OR rr.target_record_id = r.id)
     WHERE rr.dismissed_at IS NULL AND r.retracted_at IS NULL AND r.archived_at IS NULL
     GROUP BY r.id
     ORDER BY conn_count DESC
     LIMIT 1`,
  ) as unknown as { id: string; type: string; content_text: string; conn_count: number } | undefined;

  if (mcRow) {
    mostConnected = {
      id: mcRow.id,
      short_id: mcRow.id.slice(0, 8),
      type: mcRow.type,
      contentPreview: mcRow.content_text.split('\n')[0].slice(0, 100),
      connectionCount: mcRow.conn_count,
    };
  }

  // Embedding health
  const embeddingTotalRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE embedding IS NOT NULL AND retracted_at IS NULL AND archived_at IS NULL',
  ) as unknown as { count: number };

  const embeddingMismatchRow = db.get(
    'SELECT COUNT(*) as count FROM record WHERE embedding IS NOT NULL AND embedding_model != ? AND retracted_at IS NULL AND archived_at IS NULL',
    [MODEL_NAME],
  ) as unknown as { count: number };

  // Context events
  const eventCountRow = db.get(
    'SELECT COUNT(*) as count FROM context_event',
  ) as unknown as { count: number };

  const avgTokensRow = db.get(
    `SELECT AVG(total_tokens) as avg_tokens FROM (
      SELECT session_id, SUM(token_estimate) as total_tokens
      FROM context_event
      WHERE session_id IS NOT NULL
      GROUP BY session_id
    )`,
  ) as unknown as { avg_tokens: number | null };

  // Session engagement metrics
  const engagement = computeEngagement(db);

  return {
    records: {
      total,
      active,
      byType,
      retracted: retractedRow.count,
      archived: archivedRow.count,
    },
    sessions: {
      total: sessionRow.count,
      lastSessionAt: lastSessionRow?.started_at ?? null,
    },
    staleness: {
      staleCount: staleRow.count,
    },
    contradictions: {
      unresolvedCount: contradictionRow.count,
    },
    graph: {
      connectionCount: connectionRow.count,
    },
    age: {
      oldestRecord: oldestRow?.created_at ?? null,
      newestRecord: newestRow?.created_at ?? null,
    },
    embeddings: {
      currentModel: MODEL_NAME,
      totalWithEmbeddings: embeddingTotalRow.count,
      mismatchedCount: embeddingMismatchRow.count,
    },
    contextEvents: {
      totalEvents: eventCountRow.count,
      avgTokensPerSession: Math.round(avgTokensRow.avg_tokens ?? 0),
    },
    mostConnected,
    engagement,
  };
}

function computeEngagement(db: Database): LedgerStats['engagement'] {
  // Get all sessions ordered by start time
  const sessions = db.all(
    'SELECT started_at FROM session ORDER BY started_at ASC',
  ) as unknown as Array<{ started_at: string }>;

  const sessionNumber = sessions.length;

  if (sessionNumber < 2) {
    // Sessions per month (last 3 months)
    const sessionsPerMonth = computeSessionsPerMonth(db);
    return {
      sessionNumber,
      avgDaysBetween: null,
      medianDaysBetween: null,
      timeToSession3Days: null,
      currentStreakWeeks: sessionNumber > 0 ? 1 : 0,
      longestGapDays: null,
      sessionsPerMonth,
    };
  }

  // Compute gaps between consecutive sessions (in days)
  const gaps: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const prev = new Date(sessions[i - 1].started_at).getTime();
    const curr = new Date(sessions[i].started_at).getTime();
    gaps.push((curr - prev) / (1000 * 60 * 60 * 24));
  }

  const avgDaysBetween = Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10;

  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianDaysBetween = sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
    : Math.round(sorted[mid] * 10) / 10;

  const longestGapDays = Math.round(Math.max(...gaps) * 10) / 10;

  // Time to session 3
  let timeToSession3Days: number | null = null;
  if (sessions.length >= 3) {
    const first = new Date(sessions[0].started_at).getTime();
    const third = new Date(sessions[2].started_at).getTime();
    timeToSession3Days = Math.round(((third - first) / (1000 * 60 * 60 * 24)) * 10) / 10;
  }

  // Current streak: consecutive weeks (from now backwards) that have at least one session
  const now = new Date();
  const currentStreakWeeks = computeWeekStreak(sessions.map(s => new Date(s.started_at)), now);

  const sessionsPerMonth = computeSessionsPerMonth(db);

  return {
    sessionNumber,
    avgDaysBetween,
    medianDaysBetween,
    timeToSession3Days,
    currentStreakWeeks,
    longestGapDays,
    sessionsPerMonth,
  };
}

function computeWeekStreak(dates: Date[], now: Date): number {
  if (dates.length === 0) return 0;

  // Get start of current week (Monday)
  const startOfWeek = (d: Date): number => {
    const copy = new Date(d);
    const day = copy.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0
    copy.setHours(0, 0, 0, 0);
    copy.setDate(copy.getDate() - diff);
    return copy.getTime();
  };

  // Build set of week start timestamps that have sessions
  const weekSet = new Set<number>();
  for (const d of dates) {
    weekSet.add(startOfWeek(d));
  }

  // Walk backwards from current week
  let streak = 0;
  let weekStart = startOfWeek(now);
  while (weekSet.has(weekStart)) {
    streak++;
    weekStart -= 7 * 24 * 60 * 60 * 1000;
  }

  return streak;
}

function computeSessionsPerMonth(db: Database): Array<{ month: string; count: number }> {
  const rows = db.all(
    `SELECT strftime('%Y-%m', started_at) as month, COUNT(*) as count
     FROM session
     WHERE started_at >= date('now', '-3 months')
     GROUP BY month
     ORDER BY month DESC`,
  ) as unknown as Array<{ month: string; count: number }>;
  return rows;
}

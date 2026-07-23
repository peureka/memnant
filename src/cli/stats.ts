/**
 * memnant stats — Ledger statistics dashboard.
 *
 * Shows record counts, session info, graph metrics, and health indicators.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import type { LedgerStats } from '../ledger/stats.js';

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Show ledger statistics dashboard')
    .option('--json', 'Output as JSON')
    .option('--engagement', 'Show session engagement metrics')
    .action(async (opts: { json?: boolean; engagement?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { getLedgerStats } = await import('../ledger/stats.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
        process.exit(1);
      }

      let config;
      try {
        config = loadConfig(projectRoot);
      } catch (err) {
        console.error(err instanceof ConfigError ? err.message : String(err));
        process.exit(1);
      }

      const dbPath = join(projectRoot, config.memory.db_path);

      if (!existsSync(dbPath)) {
        console.error(`Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`);
        process.exit(1);
      }

      const db = openDatabase(dbPath);
      let stats: LedgerStats;
      try {
        stats = await getLedgerStats(db, projectRoot);
      } finally {
        db.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      if (opts.engagement) {
        console.log(formatEngagement(stats));
        return;
      }

      console.log(formatStats(stats, config.project.name));
    });
}

function formatEngagement(stats: LedgerStats): string {
  const eng = stats.engagement;
  const lines: string[] = [];

  lines.push(`Session #${eng.sessionNumber}`);

  if (eng.sessionNumber === 0) {
    lines.push('No sessions yet.');
    return lines.join('\n');
  }

  if (eng.avgDaysBetween !== null) {
    lines.push(`Avg days between: ${eng.avgDaysBetween}`);
    lines.push(`Median days between: ${eng.medianDaysBetween}`);
  }
  if (eng.timeToSession3Days !== null) {
    lines.push(`Time to session 3: ${eng.timeToSession3Days} days`);
  } else if (eng.sessionNumber < 3) {
    lines.push(`Time to session 3: not yet (${3 - eng.sessionNumber} more to go)`);
  }
  lines.push(`Current streak: ${eng.currentStreakWeeks} week${eng.currentStreakWeeks !== 1 ? 's' : ''}`);
  if (eng.longestGapDays !== null) {
    lines.push(`Longest gap: ${eng.longestGapDays} days`);
  }
  if (eng.sessionsPerMonth.length > 0) {
    lines.push('');
    for (const m of eng.sessionsPerMonth) {
      lines.push(`  ${m.month}: ${m.count} session${m.count !== 1 ? 's' : ''}`);
    }
  }

  return lines.join('\n');
}

function formatStats(stats: LedgerStats, projectName: string): string {
  const lines: string[] = [];

  lines.push(`memnant stats: ${projectName}`);
  lines.push('');

  // Records
  lines.push(`Records: ${stats.records.active} active / ${stats.records.total} total`);
  if (stats.records.retracted > 0) {
    lines.push(`  Retracted: ${stats.records.retracted}`);
  }
  if (stats.records.archived > 0) {
    lines.push(`  Archived: ${stats.records.archived}`);
  }

  // Type breakdown
  const typeEntries = Object.entries(stats.records.byType);
  if (typeEntries.length > 0) {
    lines.push('  By type:');
    for (const [type, count] of typeEntries) {
      lines.push(`    ${type}: ${count}`);
    }
  }

  lines.push('');

  // Sessions
  lines.push(`Sessions: ${stats.sessions.total}`);
  if (stats.sessions.lastSessionAt) {
    lines.push(`  Last: ${stats.sessions.lastSessionAt.slice(0, 10)}`);
  }

  lines.push('');

  // Health
  const healthItems: string[] = [];
  if (stats.staleness.staleCount > 0) {
    healthItems.push(`${stats.staleness.staleCount} stale`);
  }
  if (stats.contradictions.unresolvedCount > 0) {
    healthItems.push(`${stats.contradictions.unresolvedCount} contradiction(s)`);
  }
  if (healthItems.length > 0) {
    lines.push(`Health: ${healthItems.join(', ')}`);
  } else {
    lines.push('Health: clean');
  }

  // Embeddings
  lines.push('');
  lines.push(`Embedding model: ${stats.embeddings.currentModel}`);
  if (stats.embeddings.mismatchedCount > 0) {
    lines.push(`  Mismatched: ${stats.embeddings.mismatchedCount} records (run 'memnant reindex' to update)`);
  } else {
    lines.push(`  Mismatched: 0 records (all current)`);
  }

  // Context events
  if (stats.contextEvents.totalEvents > 0) {
    lines.push('');
    lines.push(`Context events: ${stats.contextEvents.totalEvents}`);
    lines.push(`  Avg tokens/session: ${stats.contextEvents.avgTokensPerSession}`);
  }

  // Graph
  if (stats.graph.connectionCount > 0) {
    lines.push(`Graph: ${stats.graph.connectionCount} connection(s)`);
  }

  // Most connected
  if (stats.mostConnected) {
    lines.push(`  Most connected: [${stats.mostConnected.short_id}] ${stats.mostConnected.type}: ${stats.mostConnected.contentPreview} (${stats.mostConnected.connectionCount} connections)`);
  }

  // Age
  if (stats.age.oldestRecord) {
    lines.push('');
    lines.push(`Oldest record: ${stats.age.oldestRecord.slice(0, 10)}`);
    lines.push(`Newest record: ${stats.age.newestRecord?.slice(0, 10) ?? 'n/a'}`);
  }

  return lines.join('\n');
}

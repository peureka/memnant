/**
 * CLI handler for `memnant analytics`.
 * Shows ledger health metrics.
 */

import { Command } from 'commander';
import { openDatabase } from '../ledger/database.js';
import { loadConfig, findProjectRoot } from '../config/load.js';
import { join } from 'path';
import { computeAnalytics } from '../analytics/analytics.js';

export function registerAnalyticsCommand(program: Command): void {
  program
    .command('analytics')
    .description('Show ledger health: decision velocity, knowledge areas, coverage gaps')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found. Run `memnant init` first.');
        process.exit(1);
      }

      const config = loadConfig(projectRoot);
      const dbPath = join(projectRoot, config.memory.db_path);
      const db = openDatabase(dbPath);

      const report = await computeAnalytics(db, config.project.id);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      // Velocity
      console.log('Decision Velocity (last 8 weeks):');
      const maxCount = Math.max(...report.velocity.weeks.map(w => w.count), 1);
      const line = report.velocity.weeks.map(w => {
        const bar = '█'.repeat(Math.round((w.count / maxCount) * 8));
        return `  ${w.week}: ${bar || '·'} ${w.count}`;
      }).join('\n');
      console.log(line);
      const sign = report.velocity.trendPercent >= 0 ? '+' : '';
      console.log(`  Trend: ${report.velocity.trend} (${sign}${report.velocity.trendPercent}%)\n`);

      // Knowledge areas
      if (report.knowledgeAreas.length > 0) {
        console.log('Knowledge Areas:');
        console.log('  ' + report.knowledgeAreas.map(a => `${a.tag} (${a.count})`).join('  '));
        console.log();
      }

      // Coverage gaps
      console.log('Coverage Gaps:');
      console.log(`  ${report.coverageGaps.forgottenDecisions} forgotten decision${report.coverageGaps.forgottenDecisions !== 1 ? 's' : ''} (anchored files not accessed in 60+ days)`);
      console.log(`  ${report.coverageGaps.undocumentedAreas} undocumented area${report.coverageGaps.undocumentedAreas !== 1 ? 's' : ''} (active files with no decisions)\n`);

      // Assumptions + review pressure
      if (report.assumptionCount > 0) {
        console.log(`Assumptions: ${report.assumptionCount} active${report.topAssumption ? `, "${report.topAssumption}" spans ${report.topAssumptionDecisions} decisions` : ''}`);
      }
      if (report.reviewPressureCount > 0) {
        console.log(`Review Pressure: ${report.reviewPressureCount} decision${report.reviewPressureCount !== 1 ? 's' : ''} due for review`);
      }

      // Decision churn
      if (report.churn && report.churn.length > 0) {
        console.log(`\nDecision Churn:`);
        for (const c of report.churn) {
          console.log(`  [${c.supersessionCount}x] "${c.contentPreview}" (chain: ${c.chainIds.length} records)`);
        }
      }
    });
}

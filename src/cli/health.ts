/**
 * memnant health — Project health summary.
 *
 * Story 13.1: Gathers stats (stale count, contradictions, session activity,
 * record growth, spec drift) and computes a health score.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Show project health summary')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { gatherHealth, formatHealthReport } = await import('../monitoring/health.js');
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

      try {
        const report = gatherHealth(db, config, projectRoot);

        if (opts.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        } else {
          console.log(formatHealthReport(report));
        }

        // Exit with non-zero for critical status (useful for CI/cron)
        if (report.status === 'critical') {
          process.exit(2);
        }
      } finally {
        db.close();
      }
    });
}

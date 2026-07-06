/**
 * memnant status — Show project status.
 *
 * Story 1.1: Prints project name, record count, session count, ledger size.
 */

import { Command } from 'commander';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show memnant project status')
    .action(async () => {
      const { openDatabase } = await import('../ledger/database.js');
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
        console.error(
          `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
        );
        process.exit(1);
      }

      const db = openDatabase(dbPath);

      let recordCount: number;
      let sessionCount: number;
      try {
        recordCount = (
          db.get('SELECT COUNT(*) as count FROM record') as unknown as {
            count: number;
          }
        ).count;
        sessionCount = (
          db.get('SELECT COUNT(*) as count FROM session') as unknown as {
            count: number;
          }
        ).count;
      } finally {
        db.close();
      }

      const dbStat = statSync(dbPath);
      const sizeKB = Math.ceil(dbStat.size / 1024);

      console.log(`Project: ${config.project.name}`);
      console.log(`Records: ${recordCount}`);
      console.log(`Sessions: ${sessionCount}`);
      console.log(`Ledger size: ${sizeKB} KB`);
    });
}

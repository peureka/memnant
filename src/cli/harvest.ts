/**
 * CLI handler for `memnant harvest`.
 * Scans the latest transcript and extracts missed records.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

export function registerHarvestCommand(program: Command): void {
  program
    .command('harvest')
    .description('Scan conversation transcripts and extract missed records')
    .option('--project-root <path>', 'Harvest transcripts from this project path instead of the current directory (records still land in the current project ledger)')
    .action(async (options: { projectRoot?: string }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
        process.exit(1);
      }

      let transcriptProjectRoot: string | undefined;
      if (options.projectRoot) {
        transcriptProjectRoot = resolve(options.projectRoot);
        if (!existsSync(transcriptProjectRoot)) {
          console.error(`--project-root path does not exist: ${transcriptProjectRoot}`);
          process.exit(1);
        }
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

      let tierConfig = null;
      try {
        if (config.orchestrator?.tiers?.analysis) {
          tierConfig = config.orchestrator.tiers.analysis;
        }
      } catch (e: any) { console.error('harvest entry failed:', e?.message); }

      const { harvest } = await import('../harvest/harvest.js');
      const result = await harvest(db, projectRoot, config.project.id, { tierConfig, transcriptProjectRoot });
      db.close();

      if (!result.transcriptPath) {
        console.log('No transcripts found.');
        return;
      }

      console.log(`Harvested: ${result.messagesRead} messages → ${result.candidatesExtracted} candidates → ${result.recordsWritten} new records (${result.duplicatesSkipped} duplicates skipped)`);
    });
}

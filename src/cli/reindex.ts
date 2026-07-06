/**
 * memnant reindex — Regenerate embeddings for records with mismatched model.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerReindexCommand(program: Command): void {
  program
    .command('reindex')
    .description('Regenerate embeddings for records with a mismatched model version')
    .option('--all', 'Reindex all records, not just mismatched ones')
    .option('--dry-run', 'Report mismatched count without changing anything')
    .action(async (opts: { all?: boolean; dryRun?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { reindexRecords } = await import('../vector/reindex.js');
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

      let result: Awaited<ReturnType<typeof reindexRecords>>;
      try {
        result = await reindexRecords(db, {
          staleOnly: !opts.all,
          dryRun: !!opts.dryRun,
          onProgress: (current, total) => {
            process.stderr.write(`\rReindexing ${current}/${total} records...`);
          },
        });
      } finally {
        db.close();
      }

      if (opts.dryRun) {
        console.log(`${result.total} record(s) with mismatched embeddings.`);
        return;
      }

      if (result.reindexed === 0) {
        console.log('All embeddings are current. Nothing to reindex.');
        return;
      }

      process.stderr.write('\n');
      console.log(`Reindexed ${result.reindexed} record(s).`);
      console.log("Embeddings updated. Run 'memnant relink' to refresh graph connections.");
    });
}

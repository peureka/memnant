/**
 * memnant spec-diff — Show what changed between spec versions.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerSpecDiffCommand(program: Command): void {
  program
    .command('spec-diff [filename]')
    .description('Show what changed between spec versions')
    .option('--all', 'Diff all specs with 2+ versions')
    .option('--json', 'Output as JSON')
    .action(async (filename: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { diffSpecSnapshots, getDiffableSpecs } = await import('../context/spec-diff.js');
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
        console.error(`Ledger database not found at ${config.memory.db_path}.`);
        process.exit(1);
      }

      const db = openDatabase(dbPath);

      let diffable: string[] = [];
      let diffs: ReturnType<typeof diffSpecSnapshots>[] = [];
      let diff: ReturnType<typeof diffSpecSnapshots> = null;
      try {
        if (opts.all || !filename) {
          diffable = getDiffableSpecs(db);
          if (diffable.length > 0) {
            diffs = diffable.map((f) => diffSpecSnapshots(db, f)).filter(Boolean);
          }
        } else {
          diff = diffSpecSnapshots(db, filename);
        }
      } finally {
        db.close();
      }

      if (opts.all || !filename) {
        if (diffable.length === 0) {
          console.log('No specs with multiple versions found. Spec changes are detected on session start.');
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(diffs, null, 2));
        } else {
          for (const d of diffs) {
            console.log(d!.diff);
            console.log('');
          }
        }
      } else {
        if (!diff) {
          console.log(`No diff available for '${filename}'. Need at least 2 snapshots.`);
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(diff, null, 2));
        } else {
          console.log(diff.diff);
        }
      }
    });
}

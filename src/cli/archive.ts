/**
 * memnant archive / unarchive — Archive old or superseded records.
 *
 * Archived records are excluded from recall, context compilation, and export.
 * They are not deleted — they can be unarchived later.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

async function loadDb() {
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
    console.error(`Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`);
    process.exit(1);
  }

  return openDatabase(dbPath);
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)d$/);
  if (!match) {
    console.error(`Invalid duration '${duration}'. Expected format: <number>d (e.g. 90d for 90 days).`);
    process.exit(1);
  }
  return parseInt(match[1], 10);
}

export function registerArchiveCommand(program: Command): void {
  program
    .command('archive')
    .description('Archive old or superseded records')
    .option('--id <id>', 'Archive a single record')
    .option('--superseded', 'Archive all superseded records')
    .option('--stale-older-than <duration>', 'Archive stale records older than duration (e.g. 90d)')
    .action(async (opts: { id?: string; superseded?: boolean; staleOlderThan?: string }) => {
      const { archiveRecord, archiveSuperseded, archiveStaleOlderThan } = await import('../ledger/admin.js');

      if (!opts.id && !opts.superseded && !opts.staleOlderThan) {
        console.error('Specify at least one: --id <id>, --superseded, or --stale-older-than <duration>');
        process.exit(1);
      }

      const db = await loadDb();
      try {
        if (opts.id) {
          archiveRecord(db, opts.id);
          console.log(`Archived record ${opts.id.slice(0, 8)}.`);
        }
        if (opts.superseded) {
          const count = archiveSuperseded(db);
          console.log(`Archived ${count} superseded record(s).`);
        }
        if (opts.staleOlderThan) {
          const days = parseDuration(opts.staleOlderThan);
          const count = archiveStaleOlderThan(db, days);
          console.log(`Archived ${count} stale record(s) older than ${days} days.`);
        }
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('unarchive')
    .description('Restore archived records')
    .option('--id <id>', 'Unarchive a single record')
    .option('--all', 'Unarchive all archived records')
    .action(async (opts: { id?: string; all?: boolean }) => {
      const { unarchiveRecord, unarchiveAll } = await import('../ledger/admin.js');

      if (!opts.id && !opts.all) {
        console.error('Specify at least one: --id <id> or --all');
        process.exit(1);
      }

      const db = await loadDb();
      try {
        if (opts.id) {
          unarchiveRecord(db, opts.id);
          console.log(`Unarchived record ${opts.id.slice(0, 8)}. It will appear in queries again.`);
        }
        if (opts.all) {
          const count = unarchiveAll(db);
          console.log(`Unarchived ${count} record(s).`);
        }
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
      } finally {
        db.close();
      }
    });
}

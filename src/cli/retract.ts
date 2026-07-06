/**
 * memnant retract / unretract — Mark records as retracted (wrong/incorrect).
 *
 * Retracted records are excluded from recall, context compilation, and export.
 * They are not deleted — they can be unretracted later.
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

export function registerRetractCommand(program: Command): void {
  program
    .command('retract <id>')
    .description('Mark a record as retracted (wrong/incorrect)')
    .requiredOption('--reason <reason>', 'Why this record is being retracted')
    .action(async (id: string, opts: { reason: string }) => {
      const { retractRecord } = await import('../ledger/admin.js');
      const db = await loadDb();
      try {
        retractRecord(db, id, opts.reason);
        console.log(`Retracted record ${id.slice(0, 8)}. Reason: ${opts.reason}`);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
      } finally {
        db.close();
      }
    });

  program
    .command('unretract <id>')
    .description('Remove retraction from a record')
    .action(async (id: string) => {
      const { unretractRecord } = await import('../ledger/admin.js');
      const db = await loadDb();
      try {
        unretractRecord(db, id);
        console.log(`Unretracted record ${id.slice(0, 8)}. It will appear in queries again.`);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
      } finally {
        db.close();
      }
    });
}

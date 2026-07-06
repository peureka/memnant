/**
 * CLI handler for `memnant history <id>`.
 * Shows the version chain of a record.
 */

import { Command } from 'commander';
import { openDatabase } from '../ledger/database.js';
import { loadConfig, findProjectRoot } from '../config/load.js';
import { join } from 'path';
import { getVersionHistory } from '../graph/history.js';

export function registerHistoryCommand(program: Command): void {
  program
    .command('history <record-id>')
    .description('Show version history of a record')
    .option('--json', 'Output as JSON')
    .action(async (recordId: string, opts: { json?: boolean }) => {
      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found. Run `memnant init` first.');
        process.exit(1);
      }

      const config = loadConfig(projectRoot);
      const dbPath = join(projectRoot, config.memory.db_path);
      const db = openDatabase(dbPath);

      let fullId = recordId;
      if (recordId.length < 36) {
        const match = db.get('SELECT id FROM record WHERE id LIKE ?', [`${recordId}%`]) as unknown as { id: string } | undefined;
        if (!match) {
          console.error(`No record found matching '${recordId}'.`);
          db.close();
          process.exit(1);
        }
        fullId = match.id;
      }

      const history = getVersionHistory(db, fullId);

      if (history.length === 0) {
        console.error(`No record found for '${recordId}'.`);
        db.close();
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(history, null, 2));
      } else {
        console.log(`Version history (${history.length} version${history.length > 1 ? 's' : ''}):\n`);
        for (const entry of history) {
          const marker = entry.id === fullId ? ' <' : '';
          const date = entry.created_at.slice(0, 10);
          const content = entry.content_text.replace(/\n/g, ' ').slice(0, 120);
          console.log(`  v${entry.version}  ${entry.id.slice(0, 8)}  ${date}  ${content}${marker}`);
        }
      }

      db.close();
    });
}

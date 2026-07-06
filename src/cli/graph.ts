/**
 * memnant graph — Connection graph visualization and management.
 *
 * Story 9.4: Text-based graph, with --json, --type, --contradictions options.
 * Also: unsupersede and dismiss-contradiction commands.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerGraphCommand(program: Command): void {
  program
    .command('graph')
    .description('Show the connection graph between records')
    .argument('[record-id]', 'Show connections for a specific record')
    .option('--json', 'Output as JSON')
    .option('--type <type>', 'Filter by record type')
    .option('--contradictions', 'Show only unresolved contradictions')
    .action(async (recordId: string | undefined, opts: { json?: boolean; type?: string; contradictions?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { buildGraph, formatGraphAsText } = await import('../graph/queries.js');
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
        const nodes = buildGraph(db, {
          recordId,
          type: opts.type,
          contradictionsOnly: opts.contradictions,
        });

        if (opts.json) {
          console.log(JSON.stringify(nodes, null, 2));
        } else {
          console.log(formatGraphAsText(nodes));
        }
      } finally {
        db.close();
      }
    });

  program
    .command('unsupersede')
    .description('Remove a supersession relationship for a record')
    .argument('<record-id>', 'Record ID to unsupersede')
    .action(async (recordId: string) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { unsupersede } = await import('../graph/relationships.js');
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
      const db = openDatabase(dbPath);

      try {
        const removed = unsupersede(db, recordId);
        if (removed) {
          console.log(`Removed supersession relationship for record ${recordId.slice(0, 8)}.`);
        } else {
          console.log(`No supersession relationship found for record ${recordId.slice(0, 8)}.`);
        }
      } finally {
        db.close();
      }
    });

  program
    .command('dismiss-contradiction')
    .description('Dismiss a contradiction between two records')
    .argument('<id1>', 'First record ID')
    .argument('<id2>', 'Second record ID')
    .action(async (id1: string, id2: string) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { dismissContradiction } = await import('../graph/relationships.js');
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
      const db = openDatabase(dbPath);

      try {
        const dismissed = dismissContradiction(db, id1, id2);
        if (dismissed) {
          console.log(`Dismissed contradiction between ${id1.slice(0, 8)} and ${id2.slice(0, 8)}.`);
        } else {
          console.log(`No active contradiction found between ${id1.slice(0, 8)} and ${id2.slice(0, 8)}.`);
        }
      } finally {
        db.close();
      }
    });
}

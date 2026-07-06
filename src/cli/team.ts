/**
 * memnant — Team collaboration commands.
 *
 * Story 15.1b: `memnant team status` — show team builder activity and health.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerTeamCommand(program: Command): void {
  const team = program
    .command('team')
    .description('Team collaboration commands');

  team
    .command('status')
    .description('Show team builder activity and health')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');
      const { getUnresolvedContradictions } = await import('../graph/relationships.js');

      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found. Run `memnant init` first.');
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
        console.error('Ledger not found. Run `memnant init` first.');
        process.exit(1);
      }

      const db = openDatabase(dbPath);

      try {
        const builders = db.all(
          `SELECT builder_id, COUNT(*) as count FROM record
           WHERE builder_id IS NOT NULL
             AND created_at > datetime('now', '-30 days')
             AND retracted_at IS NULL AND archived_at IS NULL
           GROUP BY builder_id
           ORDER BY count DESC`
        ) as any[];

        const contradictions = getUnresolvedContradictions(db);

        const lastImport = db.get(
          `SELECT created_at FROM record
           WHERE tags LIKE '%"from:%'
           ORDER BY created_at DESC LIMIT 1`
        ) as any;

        if (opts.json) {
          console.log(JSON.stringify({
            builders: builders.map((b: any) => ({
              name: b.builder_id,
              records_30d: b.count,
            })),
            contradictions: contradictions.length,
            last_import: lastImport?.created_at ?? null,
          }, null, 2));
        } else {
          console.log('Active builders (last 30 days):');
          if (builders.length === 0) {
            console.log('  (none)');
          } else {
            for (const b of builders) {
              console.log(`  ${b.builder_id}: ${b.count} record(s)`);
            }
          }
          console.log('');
          console.log(`Unresolved contradictions: ${contradictions.length}`);
          if (lastImport) {
            console.log(`Last import: ${lastImport.created_at.slice(0, 10)}`);
          }
        }
      } finally {
        db.close();
      }
    });
}

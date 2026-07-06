/**
 * memnant synthesise — Ask questions that span multiple records.
 *
 * Story 11.1: CLI for synthesis queries.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerSynthesiseCommand(program: Command): void {
  program
    .command('synthesise')
    .alias('synthesize')
    .description('Ask a question that spans multiple records')
    .argument('<question>', 'Question to synthesise an answer for')
    .option('--json', 'Output as JSON')
    .option('--colony', 'Include cross-project colony records')
    .option('--team-patterns', 'Show cross-builder consensus and divergence')
    .action(async (question: string, opts: { json?: boolean; colony?: boolean; teamPatterns?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { synthesise } = await import('../synthesis/synthesise.js');
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

      if (opts.teamPatterns) {
        const { analyzeTeamPatterns, getTeamCoverage, formatTeamPatterns } = await import('../team/patterns.js');
        const patterns = analyzeTeamPatterns(db);
        const coverage = getTeamCoverage(db);

        if (opts.json) {
          console.log(JSON.stringify({ patterns, coverage }, null, 2));
        } else {
          console.log(formatTeamPatterns(patterns, coverage));
        }
        db.close();
        return;
      }

      try {
        let colonyDb = null;
        if (opts.colony) {
          try {
            const { openColonyDb } = await import('../colony/colony.js');
            colonyDb = openColonyDb();
          } catch {
            // Colony not available
          }
        }

        const result = await synthesise(db, question, config, {
          projectRoot,
          includeColony: opts.colony ?? false,
          colonyDb,
        });

        if (colonyDb) {
          try { colonyDb.close(); } catch (e: any) { console.error('colony db close failed:', e?.message); }
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(result.answer);
          if (result.citations.length > 0) {
            console.log('\nCitations:');
            for (const c of result.citations) {
              console.log(`  [${c.short_id}] ${c.type}: ${c.content_preview.slice(0, 80)}`);
            }
          }
          if (result.fallback) {
            console.log('\n(Synthesis unavailable — showing raw records)');
          }
        }
      } finally {
        db.close();
      }
    });
}

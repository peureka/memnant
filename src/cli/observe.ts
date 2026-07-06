/**
 * CLI handler for `memnant observe`.
 * Reads conversation text from stdin and extracts records silently.
 * Designed to be called from Claude Code hooks — must never fail visibly.
 */

import { Command } from 'commander';

export function registerObserveCommand(program: Command): void {
  program
    .command('observe')
    .description('Read conversation text from stdin and extract knowledge records silently')
    .action(async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString('utf-8');

        if (!text.trim()) {
          process.exit(0);
        }

        const { openDatabase } = await import('../ledger/database.js');
        const { loadConfig, findProjectRoot } = await import('../config/load.js');
        const { join } = await import('path');
        const { existsSync } = await import('fs');

        const cwd = process.cwd();
        const projectRoot = findProjectRoot(cwd);
        if (!projectRoot) {
          process.exit(0); // Silent — no project, no action
        }

        let config;
        try {
          config = loadConfig(projectRoot);
        } catch {
          process.exit(0);
        }

        const dbPath = join(projectRoot, config.memory.db_path);
        if (!existsSync(dbPath)) {
          process.exit(0);
        }

        const db = openDatabase(dbPath);
        const { observeText } = await import('../observe/observe.js');
        const result = await observeText(db, text, config.project.id);
        db.close();

        if (result.recordsWritten > 0) {
          process.stderr.write(`observe: ${result.recordsWritten} records extracted\n`);
        }
      } catch {
        // Never fail — hooks must not block
      }
      process.exit(0);
    });
}

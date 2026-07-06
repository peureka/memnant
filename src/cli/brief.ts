/**
 * memnant — Brief CLI command.
 *
 * Story 15.4: `memnant brief --onboarding` generates a structured
 * onboarding package for new team members.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerBriefCommand(program: Command): void {
  program
    .command('brief')
    .description('Generate project briefs')
    .option('--onboarding', 'Generate onboarding brief for new team members')
    .option('--full', 'Remove token budget cap')
    .option('--json', 'Output as JSON')
    .action(async (opts: { onboarding?: boolean; full?: boolean; json?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

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
        if (opts.onboarding) {
          const { compileOnboardingBrief, formatOnboardingBrief } = await import('../context/onboarding.js');
          const brief = compileOnboardingBrief(db, config, projectRoot, { full: opts.full });

          if (opts.json) {
            console.log(JSON.stringify(brief, null, 2));
          } else {
            console.log(formatOnboardingBrief(brief));
          }
        } else {
          const { generateProjectBrief, formatBriefAsMarkdown } = await import('../context/brief.js');
          const brief = generateProjectBrief(db, config, projectRoot);

          if (opts.json) {
            console.log(JSON.stringify(brief, null, 2));
          } else {
            console.log(formatBriefAsMarkdown(brief));
          }
        }
      } finally {
        db.close();
      }
    });
}

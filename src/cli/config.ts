/**
 * memnant config — inspect and re-sync project config against the scaffold.
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Inspect and re-sync memnant.yaml against the current scaffold');

  config
    .command('migrate')
    .description('Re-stamp orchestrator tier models from the current scaffold defaults')
    .option('--dry-run', 'Report drift without writing; exits 1 if any pin has drifted')
    .action(async (opts: { dryRun?: boolean }) => {
      const { loadConfig, ConfigError, findProjectRoot } = await import('./../config/load.js');
      const { createDefaultConfig } = await import('./../config/defaults.js');
      const { planTierMigration, scaffoldTierTargets } = await import('./../config/migrate.js');

      const projectRoot = findProjectRoot(process.cwd());
      if (!projectRoot) {
        console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
        process.exit(1);
      }

      try {
        loadConfig(projectRoot);
      } catch (err) {
        console.error(err instanceof ConfigError ? err.message : String(err));
        process.exit(1);
      }

      const configPath = join(projectRoot, 'memnant.yaml');
      const raw = readFileSync(configPath, 'utf-8');

      const scaffold = createDefaultConfig('scaffold', 'scaffold');
      const targets = scaffoldTierTargets(scaffold.orchestrator.tiers as Record<string, { model: string }>);

      const { changes, updated } = planTierMigration(raw, targets);

      if (changes.length === 0) {
        console.log('Tier pins already match the scaffold. Nothing to migrate.');
        return;
      }

      for (const c of changes) {
        console.log(`${c.tier}: ${c.from} -> ${c.to}`);
      }

      if (opts.dryRun) {
        console.log(`\n${changes.length} pin(s) have drifted. Run \`memnant config migrate\` to apply.`);
        process.exit(1);
      }

      writeFileSync(configPath, updated);
      console.log(`\nMigrated ${changes.length} pin(s) in memnant.yaml.`);
    });
}

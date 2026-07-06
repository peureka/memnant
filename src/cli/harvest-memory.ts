/**
 * memnant harvest-memory — Import institutional knowledge from Claude Code memory files.
 */

import { Command } from 'commander';

export function registerHarvestMemoryCommand(program: Command): void {
  program
    .command('harvest-memory')
    .description('Import knowledge from Claude Code memory files into memnant')
    .option('--dry-run', 'Preview what would be imported without writing')
    .option('--project <name>', 'Limit to a specific project')
    .option('--threshold <number>', 'Dedup similarity threshold (default 0.92)', parseFloat)
    .option('--quiet', 'Suppress detailed output')
    .action(async (opts: { dryRun?: boolean; project?: string; threshold?: number; quiet?: boolean }) => {
      const { harvestMemory } = await import('../harvest/memory-harvest.js');

      const result = await harvestMemory({
        dryRun: opts.dryRun,
        dedupThreshold: opts.threshold,
        quiet: opts.quiet,
      });

      if (opts.quiet) {
        if (result.recordsWritten > 0) {
          console.log(`Harvested ${result.recordsWritten} record(s) from Claude Code memory`);
        }
        return;
      }

      console.log(`Scanned ${result.sourcesScanned} memory source(s), found ${result.filesFound} file(s)\n`);

      for (const detail of result.details) {
        const typeLabel = detail.memnantType ? `[${detail.memnantType}]` : '';
        const projectLabel = detail.project ? `\u2192 ${detail.project}` : '';
        const actionLabel = detail.action === 'imported'
          ? opts.dryRun ? 'WOULD IMPORT' : 'imported'
          : detail.action.toUpperCase();

        console.log(`  ${typeLabel} ${detail.file} ${projectLabel} (${actionLabel})`);
      }

      console.log(`\nHarvested: ${result.filesFound} files \u2192 ${result.candidatesExtracted} candidates \u2192 ${result.recordsWritten} new records (${result.duplicatesSkipped} duplicates skipped)`);
    });
}

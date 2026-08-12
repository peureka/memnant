/**
 * memnant import — Import an external artefact into the ledger.
 *
 * Two file formats, sniffed automatically:
 *
 * 1. memnant interchange (`"memnant_interchange": 1`) — a provider-neutral
 *    conversation or record bundle from any AI surface (ChatGPT, Claude.ai,
 *    Copilot, …). Conversations go through extraction; record bundles skip
 *    extraction but not validation, dedupe, or relationship processing.
 *    Documented in INTERCHANGE.md.
 *
 * 2. Legacy portable export (`memnant export --format portable` / team
 *    export) — framework fixes or team records from another memnant project.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { RecordType } from '../types.js';

interface PortableRecord {
  type: string;
  content_text: string;
  tags: string[];
  original_id: string;
  created_at: string;
}

interface PortableFile {
  memnant_version: string;
  source_project: string;
  source_project_id?: string;
  builder_id?: string;
  exported_at: string;
  record_count: number;
  records: PortableRecord[];
}

async function runInterchangeImport(
  data: unknown,
  projectRoot: string,
  config: any,
  dryRun: boolean,
): Promise<void> {
  const { parseInterchange } = await import('../harvest/interchange.js');
  const { importInterchange } = await import('../harvest/import.js');
  const { openDatabase } = await import('../ledger/database.js');

  const parsed = parseInterchange(data);
  if (!parsed.ok) {
    console.error('Invalid interchange file:');
    for (const error of parsed.errors) {
      console.error(`  - ${error}`);
    }
    console.error('See INTERCHANGE.md in the memnant repo for the format.');
    process.exit(1);
  }

  const dbPath = join(projectRoot, config.memory.db_path);
  if (!existsSync(dbPath)) {
    console.error(`Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`);
    process.exit(1);
  }

  let tierConfig = null;
  try {
    if (config.orchestrator?.tiers?.analysis) {
      tierConfig = config.orchestrator.tiers.analysis;
    }
  } catch { /* extraction falls back to rule-based */ }

  const db = openDatabase(dbPath);
  let result;
  try {
    result = await importInterchange(db, config.project.id, parsed.value, {
      config,
      tierConfig,
      dryRun,
    });
  } finally {
    db.close();
  }

  const title = result.title ? ` "${result.title}"` : '';
  const dupes = result.duplicatesSkipped > 0 ? ` (${result.duplicatesSkipped} duplicates skipped)` : '';
  const verb = dryRun ? 'would be written' : 'written';

  if (result.kind === 'conversation') {
    console.log(
      `Imported ${result.provider} conversation${title}: ${result.messagesRead} messages → ${result.candidates} candidates → ${result.recordsWritten} records ${verb}${dupes}`,
    );
  } else {
    console.log(
      `${dryRun ? 'Would import' : 'Imported'} ${result.recordsWritten} of ${result.candidates} records from ${result.provider}${title}${dupes}`,
    );
  }
  if (result.contradictionsFlagged > 0) {
    console.log(`${result.contradictionsFlagged} contradiction(s) flagged against existing records. Run \`memnant graph --contradictions\` to review.`);
  }
  if (dryRun) {
    console.log('Dry run — nothing was written.');
  }
}

async function runPortableImport(data: PortableFile, projectRoot: string, config: any): Promise<void> {
  const { openDatabase } = await import('../ledger/database.js');
  const { writeCandidate } = await import('../ledger/write.js');

  const dbPath = join(projectRoot, config.memory.db_path);

  if (!existsSync(dbPath)) {
    console.error(
      `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
    );
    process.exit(1);
  }

  const isTeamImport = !!data.builder_id;

  // For non-team imports, validate all records are framework_fix (backward compat)
  if (!isTeamImport) {
    const nonFixRecords = data.records.filter((r) => r.type !== 'framework_fix');
    if (nonFixRecords.length > 0) {
      console.error(
        `Only framework_fix records can be imported from legacy portable files. Found ${nonFixRecords.length} record(s) of type: ${[...new Set(nonFixRecords.map((r) => r.type))].join(', ')}. Use --team export for multi-type sharing.`,
      );
      process.exit(1);
    }
  }

  const db = openDatabase(dbPath);

  let imported = 0;
  let skipped = 0;
  try {
    // Get existing content texts for duplicate detection
    const dedupQuery = isTeamImport
      ? "SELECT content_text FROM record WHERE retracted_at IS NULL"
      : "SELECT content_text FROM record WHERE type = 'framework_fix' AND retracted_at IS NULL";
    const existingRows = db.all(dedupQuery) as unknown as Array<{ content_text: string }>;
    const existingTexts = new Set(existingRows.map((r) => r.content_text));

    const sourceTag = `from:${data.source_project ?? 'unknown'}`;
    const builderTag = data.builder_id ? `by:${data.builder_id}` : undefined;

    for (const portableRecord of data.records) {
      // Skip duplicates
      if (existingTexts.has(portableRecord.content_text)) {
        skipped++;
        continue;
      }

      const tags = [...(portableRecord.tags ?? []), 'imported', sourceTag, ...(builderTag ? [builderTag] : [])];

      // Shared integrity write: embedding, auto-link, supersession,
      // best-effort contradiction detection (write-path parity).
      await writeCandidate(
        db,
        {
          projectId: config.project.id,
          type: (isTeamImport ? portableRecord.type : 'framework_fix') as RecordType,
          contentText: portableRecord.content_text,
          tags,
        },
        { config },
      );

      existingTexts.add(portableRecord.content_text);
      imported++;
    }
  } finally {
    db.close();
  }

  const typeLabel = isTeamImport ? 'records' : 'framework fixes';
  const sourceLabel = data.source_project ? ` from "${data.source_project}"` : '';
  const builderLabel = data.builder_id ? ` by ${data.builder_id}` : '';
  const skipLabel = skipped > 0 ? ` (${skipped} skipped as duplicates)` : '';
  console.log(`Imported ${imported} ${typeLabel}${sourceLabel}${builderLabel}${skipLabel}`);
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import an interchange conversation/record bundle or a portable export file')
    .argument('<file>', 'Path to a memnant interchange or portable JSON file')
    .option('--dry-run', 'Validate, extract, and dedupe an interchange file without writing')
    .action(async (file: string, opts: { dryRun?: boolean }) => {
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      // Load project config
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

      // Read and parse the file
      if (!existsSync(file)) {
        console.error(`File not found: ${file}`);
        process.exit(1);
      }

      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, 'utf-8'));
      } catch (e: any) {
        console.error(`Failed to parse import file ${file}:`, e?.message);
        process.exit(1);
      }

      const { isInterchangeShaped } = await import('../harvest/interchange.js');
      if (isInterchangeShaped(data)) {
        await runInterchangeImport(data, projectRoot, config, !!opts.dryRun);
        return;
      }

      if (opts.dryRun) {
        console.error('--dry-run is only supported for interchange files (with "memnant_interchange": 1).');
        process.exit(1);
      }

      const portable = data as PortableFile;
      if (!portable.records || !Array.isArray(portable.records)) {
        console.error('Invalid portable file: missing "records" array.');
        process.exit(1);
      }

      await runPortableImport(portable, projectRoot, config);
    });
}

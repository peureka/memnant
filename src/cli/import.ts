/**
 * memnant import — Import portable framework fixes from another project.
 *
 * Reads a portable JSON file exported with `memnant export --format portable`,
 * validates records are framework_fix type, re-generates embeddings, and
 * inserts with fresh IDs into the current project.
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

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import records from a portable export file')
    .argument('<file>', 'Path to portable JSON file')
    .action(async (file: string) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { insertRecord } = await import('../ledger/records.js');
      const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');
      const { autoLinkRecord } = await import('../graph/relationships.js');
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

      const dbPath = join(projectRoot, config.memory.db_path);

      if (!existsSync(dbPath)) {
        console.error(
          `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
        );
        process.exit(1);
      }

      // Read and validate portable file
      if (!existsSync(file)) {
        console.error(`File not found: ${file}`);
        process.exit(1);
      }

      let data: PortableFile;
      try {
        data = JSON.parse(readFileSync(file, 'utf-8')) as PortableFile;
      } catch (e: any) {
        console.error(`Failed to parse import file ${file}:`, e?.message);
        process.exit(1);
      }

      if (!data.records || !Array.isArray(data.records)) {
        console.error('Invalid portable file: missing "records" array.');
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

          const embedding = await generateEmbedding(portableRecord.content_text);
          const embeddingBuffer = serializeEmbedding(embedding);

          const record = insertRecord(db, {
            projectId: config.project.id,
            type: (isTeamImport ? portableRecord.type : 'framework_fix') as RecordType,
            contentText: portableRecord.content_text,
            tags,
            embedding: embeddingBuffer,
          });

          // Auto-link to existing records
          autoLinkRecord(db, record, config);

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
    });
}

/**
 * memnant ingest — Import a NotebookLM markdown export into the ledger.
 *
 * Parses the same format that `memnant export --format notebooklm` produces.
 * Each section becomes a record with embeddings and auto-linking.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { RecordType } from '../types.js';

interface ParsedRecord {
  type: RecordType;
  content_text: string;
  tags: string[];
  date: string;
}

const TYPE_LABEL_MAP: Record<string, RecordType> = {
  'decisions': 'decision',
  'session logs': 'session_log',
  'framework fixes': 'framework_fix',
  'spec snapshots': 'spec_snapshot',
  'codebase snapshots': 'codebase_snapshot',
  'orchestrator tasks': 'orchestrator_task',
  'synthesis cache': 'synthesis_cache',
  'governance overrides': 'governance_override',
};

/**
 * Parse a NotebookLM markdown export into record objects.
 */
export function parseNotebookLM(markdown: string): ParsedRecord[] {
  if (!markdown.trim()) return [];

  const records: ParsedRecord[] = [];
  let currentType: RecordType = 'decision';
  let currentContent: string[] = [];
  let currentTags: string[] = [];
  let currentDate = '';
  let inRecord = false;

  const lines = markdown.split('\n');

  for (const line of lines) {
    // Type section header: ## Decisions (3)
    const typeMatch = line.match(/^## (.+?) \(\d+\)/);
    if (typeMatch) {
      // Flush previous record
      if (inRecord && currentContent.length > 0) {
        records.push({
          type: currentType,
          content_text: currentContent.join('\n').trim(),
          tags: currentTags,
          date: currentDate,
        });
        currentContent = [];
        inRecord = false;
      }

      const label = typeMatch[1].toLowerCase();
      currentType = TYPE_LABEL_MAP[label] ?? 'decision';
      continue;
    }

    // Record header: ### 2026-02-14 — a3f2beef [auth, jwt]
    const recordMatch = line.match(/^### (\d{4}-\d{2}-\d{2}) — [a-f0-9]+(?:\s+\[(.+?)\])?/);
    if (recordMatch) {
      // Flush previous record
      if (inRecord && currentContent.length > 0) {
        records.push({
          type: currentType,
          content_text: currentContent.join('\n').trim(),
          tags: currentTags,
          date: currentDate,
        });
      }

      currentDate = recordMatch[1];
      currentTags = recordMatch[2]
        ? recordMatch[2].split(',').map((t) => t.trim()).filter(Boolean)
        : [];
      currentContent = [];
      inRecord = true;
      continue;
    }

    // Section separator
    if (line.trim() === '---') {
      if (inRecord && currentContent.length > 0) {
        records.push({
          type: currentType,
          content_text: currentContent.join('\n').trim(),
          tags: currentTags,
          date: currentDate,
        });
        currentContent = [];
        inRecord = false;
      }
      continue;
    }

    // Content line
    if (inRecord) {
      currentContent.push(line);
    }
  }

  // Flush final record
  if (inRecord && currentContent.length > 0) {
    records.push({
      type: currentType,
      content_text: currentContent.join('\n').trim(),
      tags: currentTags,
      date: currentDate,
    });
  }

  return records;
}

export function registerIngestCommand(program: Command): void {
  program
    .command('ingest')
    .description('Import a NotebookLM markdown export into the ledger')
    .argument('<file>', 'Path to NotebookLM markdown file')
    .option('--dry-run', 'Show what would be imported without writing')
    .action(async (file: string, opts: { dryRun?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { insertRecord } = await import('../ledger/records.js');
      const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');
      const { autoLinkRecord } = await import('../graph/relationships.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
        process.exit(1);
      }

      if (!existsSync(file)) {
        console.error(`File not found: ${file}`);
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

      const markdown = readFileSync(file, 'utf-8');
      const parsed = parseNotebookLM(markdown);

      if (parsed.length === 0) {
        console.log('No records found in the file.');
        return;
      }

      if (opts.dryRun) {
        for (const r of parsed) {
          console.log(`[${r.type}] ${r.date} — ${r.content_text.split('\n')[0].slice(0, 80)}`);
        }
        console.log(`\n${parsed.length} record(s) would be imported.`);
        return;
      }

      const db = openDatabase(dbPath);

      // Dedup against existing content
      const existingRows = db.all(
        "SELECT content_text FROM record WHERE retracted_at IS NULL",
      ) as unknown as Array<{ content_text: string }>;
      const existingTexts = new Set(existingRows.map((r) => r.content_text));

      let imported = 0;
      let skipped = 0;

      try {
        for (const r of parsed) {
          if (existingTexts.has(r.content_text)) {
            skipped++;
            continue;
          }

          const tags = [...r.tags, 'imported', 'from:notebooklm'];
          const embedding = await generateEmbedding(r.content_text);

          const record = insertRecord(db, {
            projectId: config.project.id,
            type: r.type,
            contentText: r.content_text,
            tags,
            embedding: serializeEmbedding(embedding),
          });

          autoLinkRecord(db, record, config);
          existingTexts.add(r.content_text);
          imported++;
        }
      } finally {
        db.close();
      }

      const skipLabel = skipped > 0 ? ` (${skipped} skipped as duplicates)` : '';
      console.log(`Imported ${imported} records from NotebookLM export${skipLabel}`);
    });
}

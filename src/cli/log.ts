/**
 * memnant log — Write records to the ledger.
 *
 * Story 1.2: Creates records with type, content, tags, and related records.
 * Generates an embedding at write time using a local model.
 * Content can come from --content flag or stdin pipe.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

export function registerLogCommand(program: Command): void {
  program
    .command('log')
    .description('Write a record to the ledger')
    .requiredOption('--type <type>', 'Record type')
    .option('--content <content>', 'Record content (or pipe from stdin)')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--relates-to <ids>', 'Comma-separated related record IDs')
    .option('--target-file <path>', 'File path (relative to project root) for AST-anchored staleness')
    .option('--target-symbol <name>', 'Symbol name in target file, or "global" for entire file')
    .action(async (opts: { type: string; content?: string; tags?: string; relatesTo?: string; targetFile?: string; targetSymbol?: string }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { insertRecord } = await import('../ledger/records.js');
      const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');
      const { RECORD_TYPES } = await import('../types.js');
      const { getActiveSession } = await import('../ledger/sessions.js');
      const { computeAstHashForRecord } = await import('../ast/parser.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      // Validate record type
      if (!RECORD_TYPES.includes(opts.type as (typeof RECORD_TYPES)[number])) {
        console.error(
          `Unknown record type '${opts.type}'. Valid types: ${RECORD_TYPES.join(', ')}`,
        );
        process.exit(1);
      }

      // Get content from --content flag or stdin
      let content = opts.content;
      if (!content && !process.stdin.isTTY) {
        content = readStdin().trim();
      }

      if (!content) {
        console.error('No content provided. Use --content or pipe from stdin.');
        process.exit(1);
      }

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

      const db = openDatabase(dbPath);

      let record: ReturnType<typeof insertRecord>;
      try {
        // Parse tags and related records
        const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()) : [];
        const relatedRecords = opts.relatesTo ? opts.relatesTo.split(',').map((id) => id.trim()) : [];

        // Generate embedding
        const embedding = await generateEmbedding(content);
        const embeddingBuffer = serializeEmbedding(embedding);

        // Check for active session
        const activeSession = getActiveSession(db, config.project.id);

        // Compute AST hash if target file and symbol are provided
        let astHash: string | null = null;
        if (opts.targetFile && opts.targetSymbol) {
          try {
            astHash = await computeAstHashForRecord(opts.targetFile, opts.targetSymbol, projectRoot);
          } catch (err) {
            process.stderr.write(`AST hash computation failed: ${err}\n`);
          }
        }

        // Insert record
        record = insertRecord(db, {
          projectId: config.project.id,
          type: opts.type as (typeof RECORD_TYPES)[number],
          contentText: content,
          tags,
          relatedRecords,
          embedding: embeddingBuffer,
          sourceSession: activeSession?.id ?? null,
          targetFile: opts.targetFile ?? null,
          targetSymbol: opts.targetSymbol ?? null,
          astHash,
        });
      } finally {
        db.close();
      }

      const anchorInfo = record.ast_hash ? ` (AST-anchored: ${opts.targetSymbol} in ${opts.targetFile})` : '';
      console.log(`Created ${record.type} record ${record.id}${anchorInfo}`);
    });
}

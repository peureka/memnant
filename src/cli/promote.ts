/**
 * CLI handler for `memnant promote <record-id>`.
 * Manually promotes a project record to the colony.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import { deserializeEmbedding } from '../vector/embedding-utils.js';
import { promoteToColony } from '../colony/promote.js';
import type { Record } from '../types.js';

async function loadDb() {
  const { openDatabase } = await import('../ledger/database.js');
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
    console.error(`Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`);
    process.exit(1);
  }

  return { db: (await import('../ledger/database.js')).openDatabase(dbPath), config };
}

export async function promoteRecordById(
  projectDb: any,
  colonyDb: any,
  recordId: string,
  projectId: string,
): Promise<{ promoted: boolean; reason?: string }> {
  // Find record by full or short ID
  const row = projectDb.get(
    "SELECT * FROM record WHERE id = ? OR id LIKE ?",
    [recordId, `${recordId}%`]
  );

  if (!row) {
    return { promoted: false, reason: `Record ${recordId} not found.` };
  }

  if (!row.embedding) {
    return { promoted: false, reason: `Record ${recordId} has no embedding.` };
  }

  const record: Record = {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    content: JSON.parse(row.content),
    content_text: row.content_text,
    embedding: deserializeEmbedding(row.embedding),
    tags: JSON.parse(row.tags || '[]'),
    related_records: JSON.parse(row.related_records || '[]'),
    created_at: row.created_at,
    source_session: row.source_session,
    staleness_marker: row.staleness_marker ? JSON.parse(row.staleness_marker) : null,
    retracted_at: row.retracted_at,
    retracted_reason: row.retracted_reason,
    archived_at: row.archived_at,
    target_file: row.target_file,
    target_symbol: row.target_symbol,
    ast_hash: row.ast_hash,
    embedding_model: row.embedding_model,
  };

  const result = await promoteToColony(colonyDb, record, projectId);

  if (!result) {
    return { promoted: false, reason: 'Duplicate record already exists in colony.' };
  }

  return { promoted: true };
}

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <record-id>')
    .description('Promote a project record to the colony (cross-project knowledge)')
    .action(async (recordId: string) => {
      const { db, config } = await loadDb();
      const { openColonyDb } = await import('../colony/colony.js');
      const colonyDb = openColonyDb();
      const result = await promoteRecordById(db, colonyDb, recordId, config.project.id);
      colonyDb.close();
      db.close();
      if (result.promoted) {
        console.log(`Promoted ${recordId} to colony.`);
      } else {
        console.error(result.reason);
        process.exit(1);
      }
    });
}

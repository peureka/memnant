/**
 * memnant — Git-native team sync.
 *
 * Auto-export shareable records to .memnant/shared/ on session close.
 * Auto-import new shared records on session start.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Database } from '../ledger/database.js';

const SHAREABLE_TYPES = ['decision', 'framework_fix'];

interface SharedRecord {
  id: string;
  type: string;
  content_text: string;
  tags: string[];
  created_at: string;
  builder_id: string;
  source_project: string;
  source_project_id: string;
  exported_at: string;
}

interface RecordRow {
  id: string;
  type: string;
  content_text: string;
  tags: string;
  created_at: string;
}

/**
 * Export shareable records from this session to .memnant/shared/.
 * Returns count of records exported.
 */
export function exportSharedRecords(
  db: Database,
  sessionId: string,
  projectId: string,
  sharedDir: string,
  builderId: string,
  projectName: string,
): number {
  const placeholders = SHAREABLE_TYPES.map(() => '?').join(',');
  const records = db.all(
    `SELECT id, type, content_text, tags, created_at FROM record
     WHERE source_session = ? AND project_id = ?
       AND type IN (${placeholders})
       AND retracted_at IS NULL AND archived_at IS NULL`,
    [sessionId, projectId, ...SHAREABLE_TYPES],
  ) as unknown as RecordRow[];

  if (records.length === 0) return 0;

  mkdirSync(sharedDir, { recursive: true });

  let exported = 0;
  for (const r of records) {
    const filePath = join(sharedDir, `${r.id}.json`);
    if (existsSync(filePath)) continue;

    const shared: SharedRecord = {
      id: r.id,
      type: r.type,
      content_text: r.content_text,
      tags: JSON.parse(r.tags),
      created_at: r.created_at,
      builder_id: builderId,
      source_project: projectName,
      source_project_id: projectId,
      exported_at: new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(shared, null, 2) + '\n');
    exported++;
  }

  return exported;
}

/**
 * Import shared records from .memnant/shared/ that aren't in the local ledger.
 * Returns count of records imported.
 */
export async function importSharedRecords(
  db: Database,
  projectId: string,
  sharedDir: string,
): Promise<number> {
  if (!existsSync(sharedDir)) return 0;

  const files = readdirSync(sharedDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return 0;

  const { insertRecord } = await import('../ledger/records.js');
  const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');
  const { autoLinkRecord } = await import('../graph/relationships.js');

  let imported = 0;
  for (const file of files) {
    const recordId = file.replace('.json', '');

    // Skip if already in local ledger
    const existing = db.get('SELECT id FROM record WHERE id = ?', [recordId]);
    if (existing) continue;

    let shared: SharedRecord;
    try {
      shared = JSON.parse(readFileSync(join(sharedDir, file), 'utf-8'));
    } catch (e: any) {
      console.error(`Skipping malformed shared record ${file}:`, e?.message);
      continue;
    }

    // Content-based dedup
    const contentDupe = db.get(
      'SELECT id FROM record WHERE content_text = ? AND type = ? AND project_id = ?',
      [shared.content_text, shared.type, projectId],
    );
    if (contentDupe) continue;

    const embedding = await generateEmbedding(shared.content_text);
    const embeddingBuffer = serializeEmbedding(embedding);

    const tags = [
      ...shared.tags,
      `from:${shared.source_project}`,
      `by:${shared.builder_id}`,
    ];

    const record = insertRecord(db, {
      projectId,
      type: shared.type as any,
      contentText: shared.content_text,
      tags,
      embedding: embeddingBuffer,
      builderId: shared.builder_id,
    });

    autoLinkRecord(db, record);

    // Contradiction detection: high-similarity same-type records from different builders
    if (shared.builder_id) {
      const { dotProduct } = await import('../vector/search.js');
      const { deserializeEmbedding: deserialize } = await import('../vector/embedding-utils.js');

      const candidates = db.all(
        `SELECT id, type, embedding, builder_id FROM record
         WHERE id != ? AND type = ? AND embedding IS NOT NULL
           AND builder_id IS NOT NULL AND builder_id != ?
           AND retracted_at IS NULL AND archived_at IS NULL`,
        [record.id, shared.type, shared.builder_id],
      ) as any[];

      for (const candidate of candidates) {
        const candidateEmb = deserialize(candidate.embedding);
        const sim = dotProduct(embedding, candidateEmb);
        if (sim > 0.85) {
          const existingRel = db.get(
            `SELECT id FROM record_relationship
             WHERE ((source_record_id = ? AND target_record_id = ?)
                OR (source_record_id = ? AND target_record_id = ?))
               AND type = 'contradicts'`,
            [record.id, candidate.id, candidate.id, record.id],
          );
          if (!existingRel) {
            const { v4: makeId } = await import('uuid');
            db.run(
              `INSERT INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
               VALUES (?, ?, ?, 'contradicts', ?, ?)`,
              [makeId(), record.id, candidate.id, sim, new Date().toISOString()],
            );
          }
        }
      }
    }

    imported++;
  }

  return imported;
}

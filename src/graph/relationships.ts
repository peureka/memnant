/**
 * memnant — Connection graph: auto-linking, supersession, contradiction.
 *
 * Story 9.1: Auto-link related records at write time using vector similarity.
 * Story 9.2: Supersession detection (same type + high similarity).
 * Story 9.3: Contradiction detection (same type + moderate similarity + LLM classification).
 */

import { v4 as uuidv4 } from 'uuid';
import type { Database } from '../ledger/database.js';
import type { Record, ProjectConfig, TierConfig } from '../types.js';
import { deserializeEmbedding, serializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';

const RELATED_THRESHOLD = 0.75;
const SUPERSEDES_THRESHOLD = 0.85;
const MAX_LINKS_PER_RECORD = 5;
const MAX_LLM_CALLS_PER_WRITE = 3;

export interface Relationship {
  id: string;
  source_record_id: string;
  target_record_id: string;
  type: 'related' | 'supersedes' | 'contradicts' | 'version_of';
  similarity: number;
  created_at: string;
  dismissed_at: string | null;
}

interface CandidateRow {
  id: string;
  type: string;
  content_text: string;
  embedding: Uint8Array;
}

/**
 * Auto-link a newly inserted record to existing records based on similarity.
 * Also detects supersession for same-type, high-similarity pairs.
 *
 * Called after insertRecord().
 */
export function autoLinkRecord(
  db: Database,
  record: Record,
  config?: ProjectConfig,
): Relationship[] {
  if (!record.embedding) return [];

  const newEmbedding = record.embedding instanceof Float32Array
    ? record.embedding
    : deserializeEmbedding(record.embedding as Uint8Array);

  // Get all existing records with embeddings (exclude the new one, retracted, and archived)
  const candidates = db.all(
    'SELECT id, type, content_text, embedding FROM record WHERE id != ? AND embedding IS NOT NULL AND retracted_at IS NULL AND archived_at IS NULL',
    [record.id],
  ) as unknown as CandidateRow[];

  // Score all candidates
  const scored: Array<{ candidate: CandidateRow; similarity: number }> = [];
  for (const c of candidates) {
    const embedding = deserializeEmbedding(c.embedding);
    const similarity = dotProduct(newEmbedding, embedding);
    if (similarity >= RELATED_THRESHOLD) {
      scored.push({ candidate: c, similarity });
    }
  }

  // Sort by similarity descending, take top MAX_LINKS_PER_RECORD
  scored.sort((a, b) => b.similarity - a.similarity);
  const topLinks = scored.slice(0, MAX_LINKS_PER_RECORD);

  const relationships: Relationship[] = [];

  for (const { candidate, similarity } of topLinks) {
    // Determine relationship type
    let relType: 'related' | 'supersedes' = 'related';

    if (candidate.type === record.type && similarity >= SUPERSEDES_THRESHOLD) {
      relType = 'supersedes';
    }

    // Insert bidirectional relationships
    const fwdRel = insertRelationship(db, record.id, candidate.id, relType, similarity);
    if (fwdRel) relationships.push(fwdRel);

    const revType = relType === 'supersedes' ? 'related' : relType;
    const revRel = insertRelationship(db, candidate.id, record.id, revType, similarity);
    if (revRel) relationships.push(revRel);

    // Update related_records JSON on both records
    updateRelatedRecords(db, record.id, candidate.id);
    updateRelatedRecords(db, candidate.id, record.id);
  }

  return relationships;
}

/**
 * Detect contradictions between a new record and similar same-type records.
 * Requires an LLM call — gracefully skips if no API key is available.
 *
 * Called after autoLinkRecord().
 */
export async function detectContradictions(
  db: Database,
  record: Record,
  config: ProjectConfig,
  callModelFn?: (tier: TierConfig, system: string, user: string) => Promise<{ text: string }>,
): Promise<Relationship[]> {
  if (!callModelFn) return [];
  if (!record.embedding) return [];

  const newEmbedding = record.embedding instanceof Float32Array
    ? record.embedding
    : deserializeEmbedding(record.embedding as Uint8Array);

  // Find same-type records with moderate-to-high similarity
  const candidates = db.all(
    'SELECT id, type, content_text, embedding FROM record WHERE id != ? AND type = ? AND embedding IS NOT NULL AND retracted_at IS NULL AND archived_at IS NULL',
    [record.id, record.type],
  ) as unknown as CandidateRow[];

  const potentialContradictions: Array<{ candidate: CandidateRow; similarity: number }> = [];
  for (const c of candidates) {
    const embedding = deserializeEmbedding(c.embedding);
    const similarity = dotProduct(newEmbedding, embedding);
    if (similarity >= RELATED_THRESHOLD && similarity < SUPERSEDES_THRESHOLD) {
      potentialContradictions.push({ candidate: c, similarity });
    }
  }

  // Sort by similarity descending, limit LLM calls
  potentialContradictions.sort((a, b) => b.similarity - a.similarity);
  const toCheck = potentialContradictions.slice(0, MAX_LLM_CALLS_PER_WRITE);

  const relationships: Relationship[] = [];

  for (const { candidate, similarity } of toCheck) {
    try {
      const isContradiction = await classifyContradiction(
        record.content_text,
        candidate.content_text,
        config.orchestrator.tiers.triage,
        callModelFn,
      );

      if (isContradiction) {
        const rel = insertRelationship(db, record.id, candidate.id, 'contradicts', similarity);
        if (rel) relationships.push(rel);
        const revRel = insertRelationship(db, candidate.id, record.id, 'contradicts', similarity);
        if (revRel) relationships.push(revRel);
      }
    } catch {
      // Graceful skip if LLM call fails (no API key, network error, etc.)
      break;
    }
  }

  return relationships;
}

async function classifyContradiction(
  textA: string,
  textB: string,
  tierConfig: TierConfig,
  callModelFn: (tier: TierConfig, system: string, user: string) => Promise<{ text: string }>,
): Promise<boolean> {
  const system = 'You classify whether two records contradict each other. Respond with only "yes" or "no".';
  const user = `Record A:\n${textA.slice(0, 500)}\n\nRecord B:\n${textB.slice(0, 500)}\n\nDo these records contradict each other? Answer "yes" or "no" only.`;

  const result = await callModelFn(tierConfig, system, user);
  return result.text.trim().toLowerCase().startsWith('yes');
}

export function insertRelationship(
  db: Database,
  sourceId: string,
  targetId: string,
  type: 'related' | 'supersedes' | 'contradicts' | 'version_of',
  similarity: number,
): Relationship | null {
  const id = uuidv4();
  const createdAt = new Date().toISOString();

  try {
    db.run(
      `INSERT OR IGNORE INTO record_relationship (id, source_record_id, target_record_id, type, similarity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sourceId, targetId, type, similarity, createdAt],
    );

    return { id, source_record_id: sourceId, target_record_id: targetId, type, similarity, created_at: createdAt, dismissed_at: null };
  } catch {
    return null; // Unique constraint violation — relationship already exists
  }
}

function updateRelatedRecords(db: Database, recordId: string, relatedId: string): void {
  const row = db.get('SELECT related_records FROM record WHERE id = ?', [recordId]) as unknown as { related_records: string } | undefined;
  if (!row) return;

  const existing: string[] = JSON.parse(row.related_records);
  if (!existing.includes(relatedId)) {
    existing.push(relatedId);
    db.run('UPDATE record SET related_records = ? WHERE id = ?', [JSON.stringify(existing), recordId]);
  }
}

/**
 * Get all relationships for a record.
 */
export function getRelationships(
  db: Database,
  recordId: string,
): Relationship[] {
  const rows = db.all(
    'SELECT * FROM record_relationship WHERE (source_record_id = ? OR target_record_id = ?) AND dismissed_at IS NULL',
    [recordId, recordId],
  ) as unknown as Relationship[];

  return rows;
}

/**
 * Get unresolved contradictions across the entire ledger.
 */
export function getUnresolvedContradictions(db: Database): Relationship[] {
  const rows = db.all(
    "SELECT * FROM record_relationship WHERE type = 'contradicts' AND dismissed_at IS NULL",
  ) as unknown as Relationship[];

  return rows;
}

/**
 * Dismiss a contradiction (set dismissed_at).
 */
export function dismissContradiction(
  db: Database,
  recordIdA: string,
  recordIdB: string,
): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE record_relationship SET dismissed_at = ?
     WHERE type = 'contradicts' AND dismissed_at IS NULL
       AND ((source_record_id = ? AND target_record_id = ?) OR (source_record_id = ? AND target_record_id = ?))`,
    [now, recordIdA, recordIdB, recordIdB, recordIdA],
  );

  return (result as unknown as { changes: number })?.changes > 0;
}

/**
 * Remove a supersession relationship.
 */
export function unsupersede(
  db: Database,
  recordId: string,
): boolean {
  const result = db.run(
    `DELETE FROM record_relationship
     WHERE type = 'supersedes' AND (source_record_id = ? OR target_record_id = ?)`,
    [recordId, recordId],
  );

  return (result as unknown as { changes: number })?.changes > 0;
}

/**
 * Detect if a new record resembles a superseded ancestor in any chain,
 * indicating a decision loop (A → B → C where C ≈ A).
 */
export interface LoopDetection {
  ancestorId: string;
  ancestorContent: string;
  similarity: number;
  chainLength: number;
}

export function detectSupersessionLoop(
  db: Database,
  newRecord: { id: string; type: string; embedding?: any },
): LoopDetection | null {
  if (!newRecord.embedding) return null;

  const newEmbedding = newRecord.embedding instanceof Float32Array
    ? newRecord.embedding
    : deserializeEmbedding(newRecord.embedding as Uint8Array);

  // Find all records that have been superseded (targets of supersedes relationships)
  // and are the same type as the new record
  const supersededAncestors = db.all(
    `SELECT DISTINCT r.id, r.content_text, r.embedding FROM record r
     JOIN record_relationship rr ON rr.target_record_id = r.id AND rr.type = 'supersedes' AND rr.dismissed_at IS NULL
     WHERE r.type = ? AND r.id != ? AND r.embedding IS NOT NULL`,
    [newRecord.type, newRecord.id],
  ) as unknown as Array<{ id: string; content_text: string; embedding: Uint8Array }>;

  let bestMatch: LoopDetection | null = null;

  for (const ancestor of supersededAncestors) {
    const ancestorEmbedding = deserializeEmbedding(ancestor.embedding);
    const similarity = dotProduct(newEmbedding, ancestorEmbedding);

    if (similarity >= SUPERSEDES_THRESHOLD) {
      // Walk the chain from ancestor upward to count length
      const chainLength = countChainLength(db, ancestor.id);
      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = {
          ancestorId: ancestor.id,
          ancestorContent: ancestor.content_text,
          similarity,
          chainLength,
        };
      }
    }
  }

  return bestMatch;
}

/** Count how many records are in the supersession chain starting from a given record. */
function countChainLength(db: Database, recordId: string): number {
  let length = 1;
  let currentId = recordId;
  const visited = new Set<string>([currentId]);

  // Walk forward: who supersedes this record?
  while (true) {
    const row = db.get(
      `SELECT source_record_id FROM record_relationship
       WHERE target_record_id = ? AND type = 'supersedes' AND dismissed_at IS NULL`,
      [currentId],
    ) as unknown as { source_record_id: string } | undefined;

    if (!row || visited.has(row.source_record_id)) break;
    visited.add(row.source_record_id);
    currentId = row.source_record_id;
    length++;
  }

  // Walk backward from the original: what does this record supersede?
  currentId = recordId;
  while (true) {
    const row = db.get(
      `SELECT target_record_id FROM record_relationship
       WHERE source_record_id = ? AND type = 'supersedes' AND dismissed_at IS NULL`,
      [currentId],
    ) as unknown as { target_record_id: string } | undefined;

    if (!row || visited.has(row.target_record_id)) break;
    visited.add(row.target_record_id);
    currentId = row.target_record_id;
    length++;
  }

  return length;
}

/**
 * Get IDs of records that have been superseded.
 */
export function getSupersededRecordIds(db: Database): Set<string> {
  const rows = db.all(
    "SELECT DISTINCT target_record_id as id FROM record_relationship WHERE type = 'supersedes' AND dismissed_at IS NULL",
  ) as unknown as Array<{ id: string }>;

  return new Set(rows.map((r) => r.id));
}

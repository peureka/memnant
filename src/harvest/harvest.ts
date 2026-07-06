/**
 * Harvest orchestrator — discovers, parses, extracts, deduplicates,
 * and writes records from conversation transcripts.
 */

import type { ExtractedRecord } from './extract.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { serializeEmbedding, deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';
import { insertRecord } from '../ledger/records.js';
import { findLatestTranscript, getTranscriptDir } from './discover.js';
import { parseTranscript } from './parser.js';
import { extractKnowledge } from './extract.js';

const DEDUP_THRESHOLD = 0.90;

export async function deduplicateAgainstLedger(
  db: any,
  candidates: ExtractedRecord[],
  threshold?: number,
): Promise<ExtractedRecord[]> {
  const t = threshold ?? DEDUP_THRESHOLD;

  // Get all existing embeddings
  const rows = db.all(
    "SELECT embedding FROM record WHERE embedding IS NOT NULL AND retracted_at IS NULL AND archived_at IS NULL"
  );
  const existingEmbeddings: Float32Array[] = rows.map(
    (r: any) => deserializeEmbedding(r.embedding)
  );

  const unique: ExtractedRecord[] = [];

  for (const candidate of candidates) {
    const candidateEmbedding = await generateEmbedding(candidate.content);
    let isDuplicate = false;

    for (const existing of existingEmbeddings) {
      if (dotProduct(candidateEmbedding, existing) >= t) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      unique.push(candidate);
      // Add to existing pool so subsequent candidates dedup against earlier ones too
      existingEmbeddings.push(candidateEmbedding);
    }
  }

  return unique;
}

export interface HarvestResult {
  transcriptPath: string | null;
  messagesRead: number;
  candidatesExtracted: number;
  recordsWritten: number;
  duplicatesSkipped: number;
}

export async function harvest(
  db: any,
  projectRoot: string,
  projectId: string,
  options?: { tierConfig?: any },
): Promise<HarvestResult> {
  const transcriptDir = getTranscriptDir(projectRoot);
  const transcriptPath = findLatestTranscript(transcriptDir);

  if (!transcriptPath) {
    return { transcriptPath: null, messagesRead: 0, candidatesExtracted: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  const messages = await parseTranscript(transcriptPath);
  if (messages.length === 0) {
    return { transcriptPath, messagesRead: 0, candidatesExtracted: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  // Extract knowledge — LLM if available, rule-based fallback
  let candidates: ExtractedRecord[];
  if (options?.tierConfig) {
    try {
      const { extractWithLlm } = await import('./extract-llm.js');
      candidates = await extractWithLlm(messages, options.tierConfig);
    } catch {
      candidates = extractKnowledge(messages);
    }
  } else {
    candidates = extractKnowledge(messages);
  }

  if (candidates.length === 0) {
    return { transcriptPath, messagesRead: messages.length, candidatesExtracted: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  // Deduplicate
  const unique = await deduplicateAgainstLedger(db, candidates);
  const duplicatesSkipped = candidates.length - unique.length;

  // Write records
  for (const record of unique) {
    const embedding = await generateEmbedding(record.content);
    const embeddingBuffer = serializeEmbedding(embedding);
    insertRecord(db, {
      projectId,
      type: record.type,
      contentText: record.content,
      embedding: embeddingBuffer,
      tags: record.tags,
    });
  }

  return {
    transcriptPath,
    messagesRead: messages.length,
    candidatesExtracted: candidates.length,
    recordsWritten: unique.length,
    duplicatesSkipped,
  };
}

/**
 * Observe — real-time knowledge extraction from conversation text.
 *
 * Receives text (from hooks or stdin), runs rule-based extraction,
 * deduplicates against the ledger, and writes new records silently.
 */

import { extractKnowledge } from '../harvest/extract.js';
import { deduplicateAgainstLedger } from '../harvest/harvest.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { serializeEmbedding } from '../vector/embedding-utils.js';
import { insertRecord } from '../ledger/records.js';
import type { TranscriptMessage } from '../harvest/parser.js';

export interface ObserveResult {
  candidatesFound: number;
  recordsWritten: number;
  duplicatesSkipped: number;
}

export async function observeText(
  db: any,
  text: string,
  projectId: string,
): Promise<ObserveResult> {
  if (!text.trim()) {
    return { candidatesFound: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  // Wrap text as assistant message for the extractor
  const messages: TranscriptMessage[] = [
    { role: 'assistant', text },
  ];

  const candidates = extractKnowledge(messages);

  if (candidates.length === 0) {
    return { candidatesFound: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  // Deduplicate against existing records (threshold 0.90)
  const unique = await deduplicateAgainstLedger(db, candidates, 0.90);
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
    candidatesFound: candidates.length,
    recordsWritten: unique.length,
    duplicatesSkipped,
  };
}

/**
 * Observe — real-time knowledge extraction from conversation text.
 *
 * Receives text (from hooks or stdin), runs rule-based extraction,
 * deduplicates against the ledger, and writes new records silently.
 */

import { extractKnowledge } from '../harvest/extract.js';
import { deduplicateAgainstLedger } from '../harvest/harvest.js';
import { writeCandidate, type WriteCandidateOptions } from '../ledger/write.js';
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
  options?: WriteCandidateOptions,
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

  // Write records through the shared integrity path (parity with import).
  for (const record of unique) {
    await writeCandidate(
      db,
      { projectId, type: record.type, contentText: record.content, tags: record.tags },
      options,
    );
  }

  return {
    candidatesFound: candidates.length,
    recordsWritten: unique.length,
    duplicatesSkipped,
  };
}

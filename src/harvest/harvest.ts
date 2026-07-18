/**
 * Harvest orchestrator — discovers, parses, extracts, deduplicates,
 * and writes records from conversation transcripts.
 */

import type { ExtractedRecord } from './extract.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { serializeEmbedding, deserializeEmbedding } from '../vector/embedding-utils.js';
import { dotProduct } from '../vector/search.js';
import { insertRecord } from '../ledger/records.js';
import { findTranscriptsByMtime, getTranscriptDir } from './discover.js';
import { parseTranscript } from './parser.js';
import { extractKnowledge } from './extract.js';
import { getStatePath, readHarvestState, writeHarvestState, type HarvestState } from './watermark.js';

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

async function extractCandidates(
  messages: import('./parser.js').TranscriptMessage[],
  tierConfig: any,
): Promise<ExtractedRecord[]> {
  if (tierConfig) {
    try {
      const { extractWithLlm } = await import('./extract-llm.js');
      return await extractWithLlm(messages, tierConfig);
    } catch {
      return extractKnowledge(messages);
    }
  }
  return extractKnowledge(messages);
}

/**
 * Harvest knowledge from ALL Claude Code transcripts in the project's slug dir
 * (main sessions + agent-*.jsonl subagent transcripts).
 *
 * - `projectRoot` locates the ledger's `.memnant` dir (where the watermark
 *   sidecar lives). Records land in `projectId`'s ledger.
 * - `options.transcriptProjectRoot`, when given, derives the transcript slug
 *   dir from that path instead of `projectRoot` — used by a coordinator to
 *   harvest a worktree's transcripts into the main checkout's ledger.
 *
 * A watermark (`.memnant/harvest-state.json`) skips unchanged files entirely
 * (zero parsing/embedding) and parses only appended content from grown files.
 * The >=0.90 embedding dedup remains a safety net on top of the watermark.
 */
export async function harvest(
  db: any,
  projectRoot: string,
  projectId: string,
  options?: { tierConfig?: any; transcriptProjectRoot?: string },
): Promise<HarvestResult> {
  const transcriptRoot = options?.transcriptProjectRoot ?? projectRoot;
  const transcriptDir = getTranscriptDir(transcriptRoot);
  const files = findTranscriptsByMtime(transcriptDir);

  if (files.length === 0) {
    return { transcriptPath: null, messagesRead: 0, candidatesExtracted: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  const statePath = getStatePath(projectRoot);
  const prevState = readHarvestState(statePath);
  const nextState: HarvestState = {};

  let messagesRead = 0;
  const candidates: ExtractedRecord[] = [];

  // Oldest first: process files in mtime order, existing line order within a file.
  for (const file of files) {
    const prev = prevState[file.path];

    // Unchanged file (same mtime + size) → skip entirely, zero work.
    if (prev && prev.mtime === file.mtimeMs && prev.size === file.size) {
      nextState[file.path] = prev;
      continue;
    }

    // Grown file → parse only content appended after the recorded byte offset.
    const fromOffset = prev && file.size > prev.size ? prev.size : 0;
    const messages = await parseTranscript(file.path, fromOffset);
    messagesRead += messages.length;

    if (messages.length > 0) {
      const fileCandidates = await extractCandidates(messages, options?.tierConfig);
      candidates.push(...fileCandidates);
    }

    // Record the watermark once the file's candidates have been collected.
    nextState[file.path] = { mtime: file.mtimeMs, size: file.size };
  }

  const newestPath = files[files.length - 1].path;

  if (candidates.length === 0) {
    writeHarvestState(statePath, nextState);
    return { transcriptPath: newestPath, messagesRead, candidatesExtracted: 0, recordsWritten: 0, duplicatesSkipped: 0 };
  }

  // Deduplicate against the ledger (safety net on top of the watermark).
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

  writeHarvestState(statePath, nextState);

  return {
    transcriptPath: newestPath,
    messagesRead,
    candidatesExtracted: candidates.length,
    recordsWritten: unique.length,
    duplicatesSkipped,
  };
}

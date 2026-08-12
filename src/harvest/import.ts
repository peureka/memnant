/**
 * Interchange import pipeline — a validated interchange file goes through the
 * same machinery as transcript harvest: extraction (for conversations),
 * embedding dedupe against the ledger, insertion with provenance, and
 * relationship processing. Pre-extracted record bundles skip extraction but
 * none of the integrity steps.
 *
 * The source is the only replaceable part; the ledger semantics are invariant.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig, RecordOrigin } from '../types.js';
import type { ExtractedRecord } from './extract.js';
import type { Interchange } from './interchange.js';
import { toTranscriptMessages } from './interchange.js';
import { extractCandidates, deduplicateAgainstLedger } from './harvest.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { serializeEmbedding } from '../vector/embedding-utils.js';
import { insertRecord } from '../ledger/records.js';
import { autoLinkRecord, detectContradictions } from '../graph/relationships.js';

export interface ImportInterchangeOptions {
  /** Full project config — enables contradiction detection when a triage tier is configured. */
  config?: ProjectConfig;
  /** Analysis-tier config for LLM extraction; falls back to rule-based when absent. */
  tierConfig?: unknown;
  /** Validate, extract, and dedupe, but write nothing. */
  dryRun?: boolean;
}

export interface ImportInterchangeResult {
  kind: 'conversation' | 'records';
  provider: string;
  title?: string;
  messagesRead: number;
  candidates: number;
  /** In a dry run, the count that would have been written. */
  recordsWritten: number;
  duplicatesSkipped: number;
  contradictionsFlagged: number;
  dryRun: boolean;
}

function buildOrigin(interchange: Interchange): RecordOrigin {
  const { provider, conversation_id, title, url, exported_at } = interchange.source;
  return {
    provider,
    ...(conversation_id ? { conversation_id } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(exported_at ? { exported_at } : {}),
  };
}

export async function importInterchange(
  db: Database,
  projectId: string,
  interchange: Interchange,
  options?: ImportInterchangeOptions,
): Promise<ImportInterchangeResult> {
  const origin = buildOrigin(interchange);

  let messagesRead = 0;
  let candidates: ExtractedRecord[];

  if (interchange.kind === 'conversation') {
    const messages = toTranscriptMessages(interchange.messages);
    messagesRead = messages.length;
    candidates =
      messages.length > 0 ? await extractCandidates(messages, options?.tierConfig ?? null) : [];
  } else {
    candidates = interchange.records.map((r) => ({
      type: r.type,
      content: r.content,
      tags: r.tags ?? [],
    }));
  }

  const base: Omit<ImportInterchangeResult, 'recordsWritten' | 'duplicatesSkipped' | 'contradictionsFlagged'> = {
    kind: interchange.kind,
    provider: origin.provider,
    title: origin.title,
    messagesRead,
    candidates: candidates.length,
    dryRun: options?.dryRun ?? false,
  };

  if (candidates.length === 0) {
    return { ...base, recordsWritten: 0, duplicatesSkipped: 0, contradictionsFlagged: 0 };
  }

  const unique = await deduplicateAgainstLedger(db, candidates);
  const duplicatesSkipped = candidates.length - unique.length;

  if (options?.dryRun) {
    return { ...base, recordsWritten: unique.length, duplicatesSkipped, contradictionsFlagged: 0 };
  }

  let contradictionsFlagged = 0;

  for (const candidate of unique) {
    const tags = [...new Set([...candidate.tags, 'imported', `from:${origin.provider}`])];
    const embedding = await generateEmbedding(candidate.content);

    const record = insertRecord(db, {
      projectId,
      type: candidate.type,
      contentText: candidate.content,
      embedding: serializeEmbedding(embedding),
      tags,
      origin,
    });

    autoLinkRecord(db, record, options?.config);

    // Contradiction detection is best-effort: it needs a triage-tier LLM and
    // must never block an import (offline imports simply skip it).
    if (options?.config?.orchestrator?.tiers?.triage) {
      try {
        const { callModel } = await import('../orchestrator/providers.js');
        const flagged = await detectContradictions(db, record, options.config, callModel);
        contradictionsFlagged += flagged.length / 2; // relationships are bidirectional pairs
      } catch {
        // No API key, network failure — the import still succeeds.
      }
    }
  }

  return {
    ...base,
    recordsWritten: unique.length,
    duplicatesSkipped,
    contradictionsFlagged,
  };
}

/**
 * memnant — Synthesis: answer questions no single record can.
 *
 * Story 11.1: Synthesis query tool. Semantic search → top N by relevance →
 * send to analysis tier → return answer with citations.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig, TierConfig } from '../types.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { relevanceSearch, type RelevanceSearchOptions } from '../relevance/search.js';
import { callModel, type ModelResponse } from '../orchestrator/providers.js';
import { trackAccess } from '../relevance/access.js';

export interface SynthesisResult {
  answer: string;
  citations: Array<{
    id: string;
    short_id: string;
    type: string;
    content_preview: string;
    relevance: number;
    source?: string;
  }>;
  record_count: number;
  fallback: boolean;
}

/**
 * Synthesise an answer from multiple records.
 *
 * If fewer than 3 relevant records, falls back to returning records directly.
 * Requires API key for LLM synthesis.
 */
export async function synthesise(
  db: Database,
  question: string,
  config: ProjectConfig,
  options?: {
    projectRoot?: string;
    limit?: number;
    includeColony?: boolean;
    colonyDb?: any;
  },
): Promise<SynthesisResult> {
  const queryEmbedding = await generateEmbedding(question);
  const limit = options?.limit ?? 10;

  const searchOpts: RelevanceSearchOptions = {
    limit,
    projectRoot: options?.projectRoot,
    decayProfile: config.memory.decay_profile,
    weights: config.memory.relevance_weights,
  };

  const results = await relevanceSearch(db, queryEmbedding, searchOpts);

  // Gather builder_ids for attribution
  const builderIds = new Map<string, string | null>();
  for (const r of results) {
    const row = db.get('SELECT builder_id FROM record WHERE id = ?', [r.id]) as any;
    builderIds.set(r.id, row?.builder_id ?? null);
  }

  // Track access
  if (results.length > 0) {
    trackAccess(db, results.map((r) => r.id), 'synthesise');
  }

  // Build citations from local results
  const citations: SynthesisResult['citations'] = results.map((r) => ({
    id: r.id,
    short_id: r.id.slice(0, 8),
    type: r.type,
    content_preview: r.content_text.split('\n')[0].slice(0, 200),
    relevance: r.relevance,
    source: 'local',
  }));

  // Collect full texts for context building
  const fullTexts = new Map<string, string>();
  for (const r of results) {
    fullTexts.set(r.id, r.content_text);
  }

  // Merge colony results if requested
  if (options?.includeColony && options?.colonyDb) {
    try {
      const { searchColony } = await import('../colony/search.js');
      const colonyRecords = searchColony(options.colonyDb, queryEmbedding, { limit: Math.max(limit, 5) });
      for (const cr of colonyRecords) {
        if (!citations.some(c => c.id === cr.id)) {
          citations.push({
            id: cr.id,
            short_id: cr.id.slice(0, 8),
            type: cr.type,
            content_preview: cr.content_text.split('\n')[0].slice(0, 200),
            relevance: cr.similarity,
            source: 'colony',
          });
          fullTexts.set(cr.id, cr.content_text);
        }
      }
    } catch {
      // Colony search is best-effort
    }
  }

  // Sort merged citations by relevance
  citations.sort((a, b) => b.relevance - a.relevance);
  const topCitations = citations.slice(0, limit);

  // Fallback: fewer than 3 records — return records directly
  if (topCitations.length < 3) {
    const answer = topCitations.length === 0
      ? 'No relevant records found for this question.'
      : topCitations.map((c) => {
          const text = fullTexts.get(c.id) ?? c.content_preview;
          const builder = builderIds.get(c.id);
          const builderTag = builder ? ` by ${builder}` : '';
          const tag = c.source === 'colony' ? ' [cross-project]' : '';
          return `[${c.short_id}] (${c.type}${tag}${builderTag}) ${text}`;
        }).join('\n\n');

    return {
      answer,
      citations: topCitations,
      record_count: topCitations.length,
      fallback: true,
    };
  }

  // Build context for LLM
  const recordContext = topCitations
    .map((c, i) => {
      const text = fullTexts.get(c.id) ?? c.content_preview;
      const builder = builderIds.get(c.id);
      const builderTag = builder ? ` (builder: ${builder})` : '';
      const tag = c.source === 'colony' ? ' [cross-project]' : '';
      return `[${i + 1}] ${c.type}${tag}${builderTag} (${c.short_id}): ${text.slice(0, 500)}`;
    })
    .join('\n\n');

  const systemPrompt = `You synthesise answers from a project's institutional memory.
Given relevant records from the ledger, answer the question concisely.
Cite records by their number [1], [2], etc. When a record has a builder name, attribute it: "According to [builder]..."
If records from different builders contradict each other, surface the conflict explicitly.
Records marked [cross-project] come from other projects — note when citing them.`;

  let userPrompt = `Question: ${question}

Records:
${recordContext}

Synthesise a concise answer with citations.`;

  // Check for contradictions among included records
  const includedIds = topCitations.map(c => c.id);
  if (includedIds.length >= 2) {
    const placeholders = includedIds.map(() => '?').join(',');
    const contradictions = db.all(
      `SELECT source_record_id, target_record_id FROM record_relationship
       WHERE type = 'contradicts' AND dismissed_at IS NULL
         AND source_record_id IN (${placeholders})
         AND target_record_id IN (${placeholders})`,
      [...includedIds, ...includedIds]
    ) as any[];

    if (contradictions.length > 0) {
      const conflictLines = contradictions.map((c: any) => {
        const srcBuilder = builderIds.get(c.source_record_id) ?? 'unknown';
        const tgtBuilder = builderIds.get(c.target_record_id) ?? 'unknown';
        return `- ${srcBuilder}'s ${c.source_record_id.slice(0, 8)} contradicts ${tgtBuilder}'s ${c.target_record_id.slice(0, 8)}`;
      });
      userPrompt += `\n\nKnown conflicts:\n${conflictLines.join('\n')}\nSurface these conflicts in your answer.`;
    }
  }

  try {
    const response = await callModel(
      config.orchestrator.tiers.analysis,
      systemPrompt,
      userPrompt,
    );

    return {
      answer: response.text,
      citations: topCitations,
      record_count: topCitations.length,
      fallback: false,
    };
  } catch {
    // LLM call failed — fall back to returning records
    const answer = `(Synthesis unavailable — showing relevant records)\n\n` +
      topCitations.map((c) => {
        const text = fullTexts.get(c.id) ?? c.content_preview;
        const builder = builderIds.get(c.id);
        const builderTag = builder ? ` by ${builder}` : '';
        const tag = c.source === 'colony' ? ' [cross-project]' : '';
        return `[${c.short_id}] (${c.type}${tag}${builderTag}) ${text}`;
      }).join('\n\n');

    return {
      answer,
      citations: topCitations,
      record_count: topCitations.length,
      fallback: true,
    };
  }
}

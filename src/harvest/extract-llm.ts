/**
 * LLM-based knowledge extraction from conversation messages.
 *
 * Uses the orchestrator's analysis tier to extract structured records
 * from conversation text. Falls back to rule-based when unavailable.
 */

import type { TranscriptMessage } from './parser.js';
import type { ExtractedRecord } from './extract.js';

const VALID_TYPES = ['decision', 'framework_fix'];

export const EXTRACTION_SYSTEM_PROMPT = `You extract durable knowledge records from conversations between a user and an AI assistant. The ledger you feed must stay higher-trust than the transcript: a record is something still true, not something once said.

Output a JSON array. Each element has:
- type: "decision" or "framework_fix"
- content: 1-3 sentence summary (dense, factual, self-contained — readable without the conversation)
- tags: string array (e.g. ["rejected"], ["postgres", "architecture"])

Extract ONLY:
- Decisions the user made or explicitly accepted ("let's go with X", "yes, do that", the user directing work that follows the choice)
- Rejected approaches — something tried or seriously considered, then explicitly ruled out (tag "rejected")
- Framework fixes — a concrete problem with a solution that was applied or verified
- Superseding decisions — a choice that explicitly replaces an earlier one

Do NOT extract:
- Assistant suggestions or recommendations the user never accepted — "I recommend X" is a proposal, not a decision
- Brainstorming, open questions, or options still under discussion
- Speculative "we could / might / should consider" statements
- Status updates, small talk, and routine implementation chatter

Distinguish proposal, discussion, and commitment: only commitment (explicit acceptance, or the user acting on the choice) produces a record. When in doubt, leave it out — prefer fewer, higher-confidence records.

If nothing qualifies, return []. Return ONLY the JSON array, no markdown fences.`;

export function buildExtractionPrompt(messages: TranscriptMessage[]): string {
  const lines = messages.map(m => `[${m.role}]: ${m.text}`);
  return `Extract decisions, framework fixes, and rejected approaches from this conversation:\n\n${lines.join('\n\n')}`;
}

export function parseExtractionResponse(response: string): ExtractedRecord[] {
  try {
    // Strip markdown fences if present
    const cleaned = response.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (r: any) =>
        r &&
        typeof r.content === 'string' &&
        VALID_TYPES.includes(r.type) &&
        Array.isArray(r.tags),
    );
  } catch {
    return [];
  }
}

export async function extractWithLlm(
  messages: TranscriptMessage[],
  tierConfig: any,
): Promise<ExtractedRecord[]> {
  const { callModel } = await import('../orchestrator/providers.js');
  const prompt = buildExtractionPrompt(messages);
  const response = await callModel(tierConfig, EXTRACTION_SYSTEM_PROMPT, prompt);
  return parseExtractionResponse(response.text);
}

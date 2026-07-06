/**
 * LLM-based knowledge extraction from conversation messages.
 *
 * Uses the orchestrator's analysis tier to extract structured records
 * from conversation text. Falls back to rule-based when unavailable.
 */

import type { TranscriptMessage } from './parser.js';
import type { ExtractedRecord } from './extract.js';

const VALID_TYPES = ['decision', 'framework_fix'];

const EXTRACTION_SYSTEM_PROMPT = `You extract structured knowledge records from developer conversations.

Output a JSON array. Each element has:
- type: "decision" or "framework_fix"
- content: 1-3 sentence summary (dense, factual)
- tags: string array (e.g. ["rejected"], ["postgres", "architecture"])

Rules:
- Only extract actual decisions, framework fixes, or rejected approaches
- Tag rejections with "rejected"
- Skip small talk, status updates, and routine code discussion
- If nothing worth extracting, return []
- Return ONLY the JSON array, no markdown fences`;

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

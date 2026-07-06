/**
 * Rule-based knowledge extraction from conversation messages.
 *
 * Detects decision patterns, rejection patterns, and fix-verify patterns
 * using regex and keyword matching. No LLM required.
 */

import type { TranscriptMessage } from './parser.js';

export interface ExtractedRecord {
  type: 'decision' | 'framework_fix';
  content: string;
  tags: string[];
}

const DECISION_PATTERNS = [
  /let'?s\s+(?:go\s+with|use|pick|choose)\s+(.+?)(?:\.|$)/i,
  /(?:we'?ll|I'?ll|going\s+to)\s+use\s+(.+?)(?:\.|$)/i,
  /(?:chose|decided\s+on|going\s+with)\s+(.+?)\s+(?:over|instead|because|for)/i,
  /(?:decision|decided):\s*(.+?)(?:\.|$)/i,
];

const REJECTION_PATTERNS = [
  /tried\s+(?:using\s+)?(.+?)\s+but\s+/i,
  /(.+?)\s+didn'?t\s+work\s+because/i,
  /(?:rejected|abandoned|rolled\s+back)\s+(.+?)(?:\.|$)/i,
  /(?:switched|moved)\s+(?:from|away\s+from)\s+(.+?)\s+(?:to|because)/i,
];

const FIX_PATTERNS = [
  /(?:error|bug|issue)\s+was\s+['""]?(.+?)['""]?\.\s*(?:fixed|resolved|solved)\s+by\s+(.+?)(?:\.|$)/i,
  /(?:fixed|resolved|solved)\s+(?:by|with)\s+(.+?)(?:\.\s*(?:verified|confirmed|works))/i,
  /(?:the\s+fix|solution)\s+(?:is|was)\s+(.+?)(?:\.|$)/i,
];

export function extractKnowledge(messages: TranscriptMessage[]): ExtractedRecord[] {
  const records: ExtractedRecord[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const context = i > 0 ? messages[i - 1].text + ' ' + msg.text : msg.text;

    // Check for framework fixes first (most specific)
    for (const pattern of FIX_PATTERNS) {
      const match = msg.text.match(pattern);
      if (match) {
        records.push({
          type: 'framework_fix',
          content: msg.text,
          tags: [],
        });
        break;
      }
    }

    // Check for rejections
    for (const pattern of REJECTION_PATTERNS) {
      const match = msg.text.match(pattern);
      if (match) {
        const alreadyFix = records.some(r =>
          r.type === 'framework_fix' && r.content === msg.text
        );
        if (!alreadyFix) {
          records.push({
            type: 'decision',
            content: msg.text,
            tags: ['rejected'],
          });
        }
        break;
      }
    }

    // Check for decisions (use context: user says "let's use X", assistant confirms)
    const textToCheck = msg.role === 'assistant' ? context : msg.text;
    for (const pattern of DECISION_PATTERNS) {
      const match = textToCheck.match(pattern);
      if (match) {
        const alreadyRecorded = records.some(r => r.content === msg.text);
        if (!alreadyRecorded) {
          records.push({
            type: 'decision',
            content: msg.role === 'user' && i + 1 < messages.length
              ? msg.text + ' ' + messages[i + 1].text
              : msg.text,
            tags: [],
          });
        }
        break;
      }
    }
  }

  return records;
}

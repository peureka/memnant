/**
 * Transcript parser — reads Claude Code JSONL transcripts.
 *
 * Extracts user and assistant text messages, skipping tool_use,
 * thinking blocks, progress events, and file-history-snapshot entries.
 */

import { readFileSync } from 'fs';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

/** Concatenate the text of {type:"text"} blocks; ignore tool_result, tool_use, thinking, etc. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * Parse a Claude Code JSONL transcript into user/assistant text messages.
 *
 * When `fromByteOffset` is supplied, only content after that byte offset is
 * parsed — used by incremental harvest to read just the appended lines of a
 * grown transcript. The offset is expected to land on a line boundary (JSONL
 * lines are newline-terminated); a partial leading line simply fails JSON.parse
 * and is skipped.
 */
export async function parseTranscript(
  filePath: string,
  fromByteOffset = 0,
): Promise<TranscriptMessage[]> {
  const buffer = readFileSync(filePath);
  const content = fromByteOffset > 0
    ? buffer.subarray(fromByteOffset).toString('utf-8')
    : buffer.toString('utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'user' && entry.message?.content) {
      const text = textFromContent(entry.message.content);
      if (text.trim()) {
        messages.push({ role: 'user', text, timestamp: entry.timestamp });
      }
    }

    if (entry.type === 'assistant' && entry.message?.content) {
      const text = textFromContent(entry.message.content);
      if (text.trim()) {
        messages.push({ role: 'assistant', text, timestamp: entry.timestamp });
      }
    }
  }

  return messages;
}

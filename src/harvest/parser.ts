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

export async function parseTranscript(filePath: string): Promise<TranscriptMessage[]> {
  const content = readFileSync(filePath, 'utf-8');
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
      const text = typeof entry.message.content === 'string'
        ? entry.message.content
        : '';
      if (text.trim()) {
        messages.push({ role: 'user', text, timestamp: entry.timestamp });
      }
    }

    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const textBlocks = entry.message.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text);
      const text = textBlocks.join('\n');
      if (text.trim()) {
        messages.push({ role: 'assistant', text, timestamp: entry.timestamp });
      }
    }
  }

  return messages;
}

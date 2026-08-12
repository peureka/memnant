/**
 * memnant interchange format — the provider-neutral bundle external
 * conversation surfaces produce for `memnant import`.
 *
 * Two payload kinds share one envelope:
 * - a conversation (messages) that memnant extracts durable records from
 * - pre-extracted records that still go through validation and dedupe
 *
 * The format is versioned, strict, and human-inspectable. Any AI or adapter
 * that can emit JSON can produce it. Documented in INTERCHANGE.md (repo root).
 */

import type { TranscriptMessage } from './parser.js';

export const INTERCHANGE_VERSION = 1;

/** Record types an interchange file may carry — the durable-knowledge subset. */
export const INTERCHANGE_RECORD_TYPES = ['decision', 'framework_fix'] as const;

/** Tag-safe provider slug: lowercase alphanumerics with ., _, - separators. */
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export interface InterchangeSource {
  provider: string;
  conversation_id?: string;
  title?: string;
  url?: string;
  exported_at?: string;
}

export interface InterchangeMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface InterchangeRecord {
  type: (typeof INTERCHANGE_RECORD_TYPES)[number];
  content: string;
  tags?: string[];
}

export type Interchange =
  | { version: number; kind: 'conversation'; source: InterchangeSource; messages: InterchangeMessage[] }
  | { version: number; kind: 'records'; source: InterchangeSource; records: InterchangeRecord[] };

export type ParseResult =
  | { ok: true; value: Interchange }
  | { ok: false; errors: string[] };

/**
 * Cheap shape check used by the CLI to route a parsed JSON file:
 * interchange files declare themselves with a top-level `memnant_interchange`
 * version field, which legacy portable exports (`memnant_version`) never carry.
 */
export function isInterchangeShaped(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    'memnant_interchange' in data
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSource(raw: unknown, errors: string[]): InterchangeSource | null {
  if (!isPlainObject(raw)) {
    errors.push(
      'Missing "source" object. Every interchange file must say where it came from — at minimum source.provider, e.g. {"provider": "chatgpt"}.',
    );
    return null;
  }

  const providerRaw = raw.provider;
  let provider = '';
  if (typeof providerRaw !== 'string' || providerRaw.trim() === '') {
    errors.push(
      'source.provider must be a non-empty string naming where the conversation happened, e.g. "chatgpt", "claude", "copilot", "slack".',
    );
  } else {
    provider = providerRaw.trim().toLowerCase();
    if (!PROVIDER_PATTERN.test(provider)) {
      errors.push(
        `source.provider "${providerRaw}" is not a valid provider slug. Use lowercase letters, digits, and ".", "_", "-" (e.g. "chatgpt", "meeting-notes").`,
      );
    }
  }

  for (const field of ['conversation_id', 'title', 'url', 'exported_at'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      errors.push(`source.${field} must be a string when present.`);
    }
  }

  const source: InterchangeSource = { provider };
  for (const field of ['conversation_id', 'title', 'url', 'exported_at'] as const) {
    if (typeof raw[field] === 'string') source[field] = raw[field] as string;
  }
  return source;
}

function validateMessages(raw: unknown, errors: string[]): InterchangeMessage[] {
  if (!Array.isArray(raw)) {
    errors.push('"messages" must be an array of {role, text} objects.');
    return [];
  }

  const messages: InterchangeMessage[] = [];
  raw.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`messages[${i}] must be an object with "role" and "text".`);
      return;
    }
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      errors.push(
        `messages[${i}].role must be "user" or "assistant", got ${JSON.stringify(entry.role)}. Fold system prompts and tool output into the surrounding turns or drop them.`,
      );
      return;
    }
    if (typeof entry.text !== 'string' || entry.text.trim() === '') {
      errors.push(`messages[${i}].text must be a non-empty string.`);
      return;
    }
    if (entry.timestamp !== undefined && typeof entry.timestamp !== 'string') {
      errors.push(`messages[${i}].timestamp must be an ISO 8601 string when present.`);
      return;
    }
    messages.push({
      role: entry.role,
      text: entry.text,
      ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
    });
  });
  return messages;
}

function validateRecords(raw: unknown, errors: string[]): InterchangeRecord[] {
  if (!Array.isArray(raw)) {
    errors.push('"records" must be an array of {type, content, tags?} objects.');
    return [];
  }

  const records: InterchangeRecord[] = [];
  raw.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`records[${i}] must be an object with "type" and "content".`);
      return;
    }
    if (!(INTERCHANGE_RECORD_TYPES as readonly string[]).includes(entry.type as string)) {
      errors.push(
        `records[${i}].type is ${JSON.stringify(entry.type)}. Valid types: ${INTERCHANGE_RECORD_TYPES.join(', ')}.`,
      );
      return;
    }
    if (typeof entry.content !== 'string' || entry.content.trim() === '') {
      errors.push(`records[${i}].content must be a non-empty string.`);
      return;
    }
    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== 'string')) {
        errors.push(`records[${i}].tags must be an array of strings when present.`);
        return;
      }
    }
    records.push({
      type: entry.type as InterchangeRecord['type'],
      content: entry.content,
      ...(Array.isArray(entry.tags) ? { tags: entry.tags as string[] } : {}),
    });
  });
  return records;
}

/**
 * Validate a parsed JSON value as an interchange file.
 * Collects every problem in one pass so a hand-written or AI-generated file
 * can be fixed in one round trip.
 */
export function parseInterchange(data: unknown): ParseResult {
  if (!isPlainObject(data)) {
    return {
      ok: false,
      errors: ['Not a memnant interchange file: expected a top-level JSON object.'],
    };
  }

  const errors: string[] = [];

  const version = data.memnant_interchange;
  if (version !== INTERCHANGE_VERSION) {
    return {
      ok: false,
      errors: [
        `Unsupported interchange version ${JSON.stringify(version)}. This build of memnant supports version ${INTERCHANGE_VERSION}. Set "memnant_interchange": ${INTERCHANGE_VERSION}.`,
      ],
    };
  }

  const source = validateSource(data.source, errors);

  const hasMessages = data.messages !== undefined;
  const hasRecords = data.records !== undefined;

  if (hasMessages && hasRecords) {
    errors.push(
      'File contains both "messages" and "records". Provide one payload: a conversation to extract decisions from, or pre-extracted records.',
    );
  } else if (!hasMessages && !hasRecords) {
    errors.push(
      'File contains neither "messages" nor "records". Provide a conversation ("messages") or pre-extracted records ("records").',
    );
  }

  let messages: InterchangeMessage[] = [];
  let records: InterchangeRecord[] = [];
  if (hasMessages && !hasRecords) messages = validateMessages(data.messages, errors);
  if (hasRecords && !hasMessages) records = validateRecords(data.records, errors);

  if (errors.length > 0 || !source) {
    return { ok: false, errors };
  }

  if (hasRecords) {
    return { ok: true, value: { version: INTERCHANGE_VERSION, kind: 'records', source, records } };
  }
  return { ok: true, value: { version: INTERCHANGE_VERSION, kind: 'conversation', source, messages } };
}

/** Normalise interchange messages onto the harvest pipeline's canonical shape. */
export function toTranscriptMessages(messages: InterchangeMessage[]): TranscriptMessage[] {
  return messages.map((m) => ({ role: m.role, text: m.text, timestamp: m.timestamp }));
}

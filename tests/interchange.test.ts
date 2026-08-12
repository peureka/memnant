/**
 * Tests for the memnant interchange format — the provider-neutral
 * conversation/record bundle that external AI surfaces (ChatGPT, Claude.ai,
 * Copilot, Slack exports, …) produce for `memnant import`.
 *
 * Validation only — the import pipeline is covered in import-interchange.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  parseInterchange,
  isInterchangeShaped,
  toTranscriptMessages,
  INTERCHANGE_VERSION,
} from '../src/harvest/interchange.js';

function validConversation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memnant_interchange: 1,
    source: {
      provider: 'chatgpt',
      conversation_id: 'c-123',
      title: 'Pricing model discussion',
      url: 'https://chatgpt.com/c/c-123',
      exported_at: '2026-08-10T14:00:00Z',
    },
    messages: [
      { role: 'user', text: 'Should we do per-seat or usage-based pricing?' },
      { role: 'assistant', text: 'Usage-based fits your API product better because costs scale with load.' },
      { role: 'user', text: "Let's go with usage-based pricing then. Per-seat penalises our biggest advocates." },
    ],
    ...overrides,
  };
}

function validRecords(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memnant_interchange: 1,
    source: { provider: 'claude', title: 'Auth architecture review' },
    records: [
      { type: 'decision', content: 'Chose session cookies over JWTs for the dashboard: simpler revocation.', tags: ['auth'] },
      { type: 'framework_fix', content: 'Next.js middleware cannot read httpOnly cookies set in the same request; read them in the route handler instead.' },
    ],
    ...overrides,
  };
}

describe('interchange shape sniffing', () => {
  it('recognises interchange-shaped objects', () => {
    expect(isInterchangeShaped(validConversation())).toBe(true);
    expect(isInterchangeShaped(validRecords())).toBe(true);
  });

  it('rejects legacy portable export files and arbitrary JSON', () => {
    expect(isInterchangeShaped({ memnant_version: '0.9.0', records: [] })).toBe(false);
    expect(isInterchangeShaped({ foo: 'bar' })).toBe(false);
    expect(isInterchangeShaped([1, 2, 3])).toBe(false);
    expect(isInterchangeShaped(null)).toBe(false);
    expect(isInterchangeShaped('memnant_interchange')).toBe(false);
  });
});

describe('interchange validation — envelope', () => {
  it('accepts a valid conversation file', () => {
    const result = parseInterchange(validConversation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('conversation');
    expect(result.value.source.provider).toBe('chatgpt');
    expect(result.value.source.title).toBe('Pricing model discussion');
  });

  it('accepts a valid records file', () => {
    const result = parseInterchange(validRecords());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('records');
    if (result.value.kind !== 'records') return;
    expect(result.value.records).toHaveLength(2);
  });

  it('rejects non-object input', () => {
    const result = parseInterchange('not an object');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('JSON object');
  });

  it('rejects unsupported versions with a helpful message', () => {
    const result = parseInterchange(validConversation({ memnant_interchange: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('version 99');
    expect(result.errors.join(' ')).toContain(String(INTERCHANGE_VERSION));
  });

  it('rejects a missing source object', () => {
    const result = parseInterchange(validConversation({ source: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('source');
  });

  it('rejects a missing or empty source.provider', () => {
    const noProvider = parseInterchange(validConversation({ source: { title: 'x' } }));
    expect(noProvider.ok).toBe(false);

    const emptyProvider = parseInterchange(validConversation({ source: { provider: '  ' } }));
    expect(emptyProvider.ok).toBe(false);
  });

  it('normalises provider to trimmed lowercase', () => {
    const result = parseInterchange(validConversation({ source: { provider: '  ChatGPT ' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.provider).toBe('chatgpt');
  });

  it('accepts provider-neutral values without a whitelist', () => {
    for (const provider of ['copilot', 'claude', 'slack', 'teams', 'cursor', 'meeting-notes']) {
      const result = parseInterchange(validConversation({ source: { provider } }));
      expect(result.ok).toBe(true);
    }
  });

  it('rejects providers that would corrupt tags', () => {
    const result = parseInterchange(validConversation({ source: { provider: 'chat gpt!!' } }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-string optional source fields', () => {
    const result = parseInterchange(
      validConversation({ source: { provider: 'chatgpt', url: 42 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('source.url');
  });

  it('rejects a file with both messages and records', () => {
    const both = validConversation({ records: [{ type: 'decision', content: 'x' }] });
    const result = parseInterchange(both);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('both');
  });

  it('rejects a file with neither messages nor records', () => {
    const result = parseInterchange({ memnant_interchange: 1, source: { provider: 'chatgpt' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('neither');
  });
});

describe('interchange validation — messages', () => {
  it('accepts an empty conversation (valid, yields nothing)', () => {
    const result = parseInterchange(validConversation({ messages: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('conversation');
    if (result.value.kind !== 'conversation') return;
    expect(result.value.messages).toHaveLength(0);
  });

  it('rejects messages that is not an array', () => {
    const result = parseInterchange(validConversation({ messages: 'hello' }));
    expect(result.ok).toBe(false);
  });

  it('rejects invalid roles, naming the offending index', () => {
    const result = parseInterchange(
      validConversation({
        messages: [
          { role: 'user', text: 'hi' },
          { role: 'system', text: 'you are a bot' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('messages[1]');
    expect(result.errors.join(' ')).toContain('system');
  });

  it('rejects messages with missing or empty text', () => {
    const result = parseInterchange(
      validConversation({ messages: [{ role: 'user', text: '   ' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('messages[0]');
  });

  it('rejects non-string timestamps', () => {
    const result = parseInterchange(
      validConversation({ messages: [{ role: 'user', text: 'hi', timestamp: 123 }] }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('interchange validation — records', () => {
  it('rejects unknown record types with the valid list', () => {
    const result = parseInterchange(
      validRecords({ records: [{ type: 'note', content: 'remember this' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join(' ');
    expect(text).toContain('note');
    expect(text).toContain('decision');
    expect(text).toContain('framework_fix');
  });

  it('rejects records with missing or empty content', () => {
    const result = parseInterchange(validRecords({ records: [{ type: 'decision', content: '' }] }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-string tags', () => {
    const result = parseInterchange(
      validRecords({ records: [{ type: 'decision', content: 'x', tags: [1, 2] }] }),
    );
    expect(result.ok).toBe(false);
  });

  it('accepts records with omitted tags', () => {
    const result = parseInterchange(
      validRecords({ records: [{ type: 'decision', content: 'Chose X over Y.' }] }),
    );
    expect(result.ok).toBe(true);
  });

  it('collects multiple errors in one pass', () => {
    const result = parseInterchange({
      memnant_interchange: 1,
      source: {},
      messages: [{ role: 'robot', text: '' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('toTranscriptMessages', () => {
  it('maps interchange messages onto the harvest TranscriptMessage shape', () => {
    const parsed = parseInterchange(
      validConversation({
        messages: [
          { role: 'user', text: 'Use Postgres.', timestamp: '2026-08-10T14:00:00Z' },
          { role: 'assistant', text: 'Agreed — Postgres over MySQL for JSON support.' },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.kind !== 'conversation') return;

    const messages = toTranscriptMessages(parsed.value.messages);
    expect(messages).toEqual([
      { role: 'user', text: 'Use Postgres.', timestamp: '2026-08-10T14:00:00Z' },
      { role: 'assistant', text: 'Agreed — Postgres over MySQL for JSON support.', timestamp: undefined },
    ]);
  });
});

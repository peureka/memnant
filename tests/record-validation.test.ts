import { describe, it, expect, vi } from 'vitest';
import { insertRecord } from '../src/ledger/records.js';

describe('insertRecord validation', () => {
  const mockDb = { run: vi.fn(), get: vi.fn(), all: vi.fn() };
  const validEmbedding = new Uint8Array(384 * 4);

  it('throws on empty projectId', () => {
    expect(() =>
      insertRecord(mockDb as any, {
        projectId: '',
        type: 'decision',
        contentText: 'some text',
        embedding: validEmbedding,
      }),
    ).toThrow('projectId is required');
  });

  it('throws on empty contentText', () => {
    expect(() =>
      insertRecord(mockDb as any, {
        projectId: 'proj-1',
        type: 'decision',
        contentText: '',
        embedding: validEmbedding,
      }),
    ).toThrow('contentText is required');
  });

  it('throws on invalid type', () => {
    expect(() =>
      insertRecord(mockDb as any, {
        projectId: 'proj-1',
        type: 'invalid_type' as any,
        contentText: 'some text',
        embedding: validEmbedding,
      }),
    ).toThrow('Invalid record type');
  });

  it('accepts valid params without throwing', () => {
    expect(() =>
      insertRecord(mockDb as any, {
        projectId: 'proj-1',
        type: 'decision',
        contentText: 'some text',
        embedding: validEmbedding,
      }),
    ).not.toThrow();
  });
});

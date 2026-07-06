import { describe, it, expect, vi } from 'vitest';
import { buildGraph } from '../src/graph/queries.js';

describe('graph batch query', () => {
  it('uses batch query instead of N+1', () => {
    const allCalls: string[] = [];
    const mockDb = {
      all: vi.fn((sql: string, _params?: any[]) => {
        allCalls.push(sql);
        if (sql.includes('FROM record')) {
          return [
            { id: 'r1', type: 'decision', content_text: 'test', created_at: '2025-01-01', tags: '[]' },
            { id: 'r2', type: 'decision', content_text: 'test2', created_at: '2025-01-02', tags: '[]' },
            { id: 'r3', type: 'decision', content_text: 'test3', created_at: '2025-01-03', tags: '[]' },
          ];
        }
        return [];
      }),
      get: vi.fn(),
    };

    buildGraph(mockDb as any);

    const relationshipQueries = allCalls.filter(q => q.includes('record_relationship'));
    expect(relationshipQueries.length).toBe(1);
  });
});

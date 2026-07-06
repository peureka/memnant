import { describe, it, expect } from 'vitest';
import { callModelSafe } from '../src/orchestrator/providers.js';

describe('callModelSafe', () => {
  it('returns empty response when model call fails', async () => {
    const result = await callModelSafe(
      {
        provider: 'openai-compatible',
        model: 'fake',
        base_url: 'http://localhost:99999/v1',
      },
      'system',
      'user',
    );

    expect(result.text).toBe('');
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('returns empty response for unsupported provider', async () => {
    const result = await callModelSafe(
      { provider: 'nonexistent', model: 'x' },
      'system',
      'user',
    );

    expect(result.text).toBe('');
    expect(result.error).toContain('Unsupported provider');
  });
});

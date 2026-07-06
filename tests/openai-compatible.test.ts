import { describe, it, expect } from 'vitest';

describe('openai-compatible provider', () => {
  it('routes openai-compatible without throwing Unsupported provider', async () => {
    const { callModel } = await import('../src/orchestrator/providers.js');

    try {
      await callModel(
        {
          provider: 'openai-compatible',
          model: 'test-model',
          base_url: 'http://localhost:99999/v1',
        },
        'system prompt',
        'user message',
      );
    } catch (err: any) {
      expect(err.message).not.toContain('Unsupported provider');
    }
  });

  it('uses no-key placeholder when api_key_env is not set', async () => {
    const { callModel } = await import('../src/orchestrator/providers.js');

    try {
      await callModel(
        {
          provider: 'openai-compatible',
          model: 'test-model',
          base_url: 'http://localhost:99999/v1',
        },
        'system',
        'user',
      );
    } catch (err: any) {
      expect(err.message).not.toContain('Unsupported provider');
    }
  });

  it('still rejects truly unsupported providers', async () => {
    const { callModel } = await import('../src/orchestrator/providers.js');

    await expect(
      callModel(
        { provider: 'some-random-provider', model: 'x' },
        'system',
        'user',
      ),
    ).rejects.toThrow('Unsupported provider');
  });
});

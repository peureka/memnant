/**
 * Tests for the orchestrator tier pins stamped into every new project.
 *
 * `memnant init` copies these into the project's memnant.yaml, where they are
 * never re-synced. A stale pin here propagates silently across the whole fleet,
 * so the scaffold asserts its models explicitly rather than by shape.
 */

import { describe, it, expect } from 'vitest';

describe('Orchestrator tiers', () => {
  it('stamps a current-generation model on every tier of a new project', async () => {
    const { createDefaultConfig } = await import('../src/config/defaults.js');
    const { tiers } = createDefaultConfig('scaffold-probe', 'test-id').orchestrator;

    expect(tiers.triage.model).toBe('claude-haiku-4-5');
    expect(tiers.analysis.model).toBe('claude-sonnet-5');
    expect(tiers.build.model).toBe('claude-opus-5');
  });

  it('prices every stamped tier, so cost reporting is never silently zero', async () => {
    const { createDefaultConfig } = await import('../src/config/defaults.js');
    const { computeCost } = await import('../src/orchestrator/costs.js');
    const { tiers } = createDefaultConfig('scaffold-probe', 'test-id').orchestrator;

    for (const tier of Object.values(tiers)) {
      expect(computeCost(tier.model, 1_000_000, 0)).toBeGreaterThan(0);
    }
  });
});

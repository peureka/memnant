/**
 * Tests for cost recording on model calls.
 *
 * `memnant costs` reads cost tags off orchestrator_task records. Nothing wrote
 * them, so the command could only ever report "no cost data" while telling the
 * user costs are logged automatically. Every LLM call funnels through callModel,
 * which is where the spend becomes observable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const create = vi.fn(async () => ({
  content: [{ type: 'text', text: 'ok' }],
  usage: { input_tokens: 1_000_000, output_tokens: 0 },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
  },
}));

describe('Cost recording', () => {
  beforeEach(async () => {
    create.mockClear();
    const { drainCosts } = await import('../src/orchestrator/costs.js');
    drainCosts();
  });

  it('records what a completed call cost, against the tier that made it', async () => {
    const { callModel } = await import('../src/orchestrator/providers.js');
    const { drainCosts } = await import('../src/orchestrator/costs.js');

    await callModel(
      { provider: 'anthropic', model: 'claude-opus-5', name: 'analysis' } as any,
      'system',
      'user',
    );

    const drained = drainCosts();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      tier: 'analysis',
      model: 'claude-opus-5',
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(drained[0]!.cost_usd).toBeCloseTo(5.0, 6);
  });

  it('hands each cost over exactly once, so a session cannot double-bill', async () => {
    const { callModel } = await import('../src/orchestrator/providers.js');
    const { drainCosts } = await import('../src/orchestrator/costs.js');

    await callModel(
      { provider: 'anthropic', model: 'claude-opus-5', name: 'analysis' } as any,
      'system',
      'user',
    );

    expect(drainCosts()).toHaveLength(1);
    expect(drainCosts()).toHaveLength(0);
  });
});

describe('Tier attribution', () => {
  it('stamps each loaded tier with its own name, so spend is attributable', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { loadConfig } = await import('../src/config/load.js');

    const dir = mkdtempSync(join(tmpdir(), 'memnant-tier-'));
    writeFileSync(join(dir, 'memnant.yaml'), [
      'project:', '  name: probe', '  id: probe-id',
      'memory:', '  db_path: .memnant/ledger.db',
      'orchestrator:', '  tiers:',
      '    triage:', '      provider: anthropic', '      model: claude-haiku-4-5',
      '    analysis:', '      provider: anthropic', '      model: claude-sonnet-5',
      '    build:', '      provider: anthropic', '      model: claude-opus-5',
      '',
    ].join('\n'));

    const { tiers } = loadConfig(dir).orchestrator;
    expect(tiers.triage.name).toBe('triage');
    expect(tiers.analysis.name).toBe('analysis');
    expect(tiers.build.name).toBe('build');
  });
});

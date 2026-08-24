/**
 * Tests for re-stamping a project's tier pins from the current scaffold.
 *
 * `memnant init` copies defaults.ts into each project's memnant.yaml, after
 * which the two never re-sync. Correcting the scaffold fixes new projects only;
 * on 2026-08-24 the existing 40 needed a hand-written sweep, and would drift
 * again at the next model generation. This makes the re-stamp a command.
 *
 * Rewrites targeted lines rather than round-tripping the YAML, so comments,
 * key order and unrelated settings survive untouched.
 */

import { describe, it, expect } from 'vitest';
import { planTierMigration } from '../src/config/migrate.js';

const YAML = `project:
  name: probe
  id: probe-id
memory:
  db_path: .memnant/ledger.db
  max_spec_snapshots: 5
orchestrator:
  tiers:
    triage:
      provider: anthropic
      model: claude-haiku-4-5-20251001
      max_context_tokens: 2000
    analysis:
      provider: anthropic
      model: claude-sonnet-4-5-20250929
      max_context_tokens: 8000
    build:
      provider: anthropic
      model: claude-opus-4-6
      max_context_tokens: 32000
  interfaces:
    cli:
      enabled: true
security:
  staging_only: true
`;

const TARGET = { triage: 'claude-haiku-4-5', analysis: 'claude-sonnet-5', build: 'claude-opus-5' };

describe('Tier migration', () => {
  it('names every pin that drifted from the scaffold', () => {
    const { changes } = planTierMigration(YAML, TARGET);
    expect(changes).toEqual([
      { tier: 'triage', from: 'claude-haiku-4-5-20251001', to: 'claude-haiku-4-5' },
      { tier: 'analysis', from: 'claude-sonnet-4-5-20250929', to: 'claude-sonnet-5' },
      { tier: 'build', from: 'claude-opus-4-6', to: 'claude-opus-5' },
    ]);
  });

  it('rewrites only the model lines, leaving the rest of the file byte-identical', () => {
    const { updated } = planTierMigration(YAML, TARGET);
    expect(updated).toContain('model: claude-sonnet-5');
    // Everything that is not a model line survives unchanged.
    const strip = (s: string) => s.split('\n').filter((l) => !l.includes('model:')).join('\n');
    expect(strip(updated)).toBe(strip(YAML));
    // Context sizes are user-tuned, not scaffold-owned.
    expect(updated).toContain('max_context_tokens: 8000');
  });

  it('reports no drift when the file already matches, and changes nothing', () => {
    const { updated } = planTierMigration(YAML, TARGET);
    const second = planTierMigration(updated, TARGET);
    expect(second.changes).toEqual([]);
    expect(second.updated).toBe(updated);
  });

  it('leaves a model line alone when its tier is not one the scaffold owns', () => {
    const custom = YAML.replace('    build:', '    custom:');
    const { changes } = planTierMigration(custom, TARGET);
    expect(changes.map((c) => c.tier)).toEqual(['triage', 'analysis']);
    expect(planTierMigration(custom, TARGET).updated).toContain('model: claude-opus-4-6');
  });
});

describe('CLI registration', () => {
  it('config command is registered in the CLI index', async () => {
    const { readFileSync } = await import('fs');
    const index = readFileSync('src/cli/index.ts', 'utf-8');
    expect(index).toContain('registerConfigCommand');
  });
});

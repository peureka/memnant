/**
 * memnant — Default configuration.
 *
 * These defaults are used when generating memnant.yaml via `memnant init`.
 * They match the configuration structure defined in docs/SPEC.md.
 */

import type { ProjectConfig } from '../types.js';

export function createDefaultConfig(
  name: string,
  id: string,
): ProjectConfig {
  return {
    project: {
      name,
      id,
    },
    memory: {
      db_path: '.memnant/ledger.db',
      export_path: '.memnant/export/',
      snapshot_interval: 'monthly',
      max_spec_snapshots: 5,
      max_codebase_snapshots: 3,
    },
    orchestrator: {
      tiers: {
        triage: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          max_context_tokens: 2000,
        },
        analysis: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5-20250929',
          max_context_tokens: 8000,
        },
        build: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          max_context_tokens: 32000,
        },
      },
      interfaces: {
        telegram: { enabled: false },
        cli: { enabled: true },
        mcp: { enabled: true, port: 3100 },
      },
    },
    governor: {
      docs_path: 'docs/',
      lint_on_pr: true,
      strict_mode: false,
    },
    context: {
      choreography: true,       // advisory workflow nudges in session_context (ON-but-quiet)
      review_tag: 'codex-review', // tag that signals a spec has been cross-reviewed
    },
    security: {
      staging_only: true,
      allow_deploy: false,
      allowed_mcp_tools: [],
    },
  };
}

/**
 * memnant — Shared type definitions.
 *
 * These types mirror the data model defined in docs/SPEC.md.
 * If the spec changes, these types change. If these types change
 * without the spec changing, something is wrong.
 */

export const RECORD_TYPES = [
  'session_log',
  'decision',
  'framework_fix',
  'spec_snapshot',
  'codebase_snapshot',
  'orchestrator_task',
  'synthesis_cache',
  'governance_override',
  'pattern',
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

export interface Project {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

export interface Record {
  id: string;
  project_id: string;
  type: RecordType;
  content: object;
  content_text: string;
  embedding?: Float32Array;
  tags: string[];
  related_records: string[];
  created_at: string;
  source_session: string | null;
  /** Unused; dynamic staleness (see computeLiveStaleRecordIds) supersedes it. Vestigial, always null. */
  staleness_marker: object | null;
  retracted_at: string | null;
  retracted_reason: string | null;
  archived_at: string | null;
  target_file: string | null;
  target_symbol: string | null;
  ast_hash: string | null;
  embedding_model: string | null;
  pattern_strength?: number | null;
  pattern_last_seen?: string | null;
  supporting_records?: string | null;
  assumptions?: string[] | null;
  builder_id?: string | null;
}

export interface Session {
  id: string;
  project_id: string;
  started_at: string;
  closed_at: string | null;
  epic: string | null;
  stories_completed: string[];
  log_record_id: string | null;
  log_skipped: string | null; // null = not skipped, string = skip reason
}

export interface ContextEvent {
  id: string;
  session_id: string | null;
  tool_name: string;
  query: string | null;
  response: string;
  token_estimate: number | null;
  created_at: string;
}

export interface ProjectConfig {
  project: {
    name: string;
    id: string;
    builder?: string;
  };
  memory: {
    db_path: string;
    export_path: string;
    snapshot_interval: 'monthly' | 'milestone';
    max_spec_snapshots: number;
    max_codebase_snapshots: number;
    relevance_weights?: {
      similarity: number;
      recency: number;
      freshness: number;
      frequency: number;
    };
    decay_profile?: 'fast' | 'default' | 'slow';
    review_pressure_days?: number;
    templates?: {
      [type: string]: {
        required_fields?: string[];
        optional_fields?: string[];
      };
    };
  };
  orchestrator: {
    tiers: {
      triage: TierConfig;
      analysis: TierConfig;
      build: TierConfig;
    };
    interfaces: {
      telegram: { enabled: boolean };
      cli: { enabled: boolean };
      mcp: { enabled: boolean; port: number };
    };
  };
  governor: {
    docs_path: string;
    lint_on_pr: boolean;
    strict_mode: boolean;
    plugins?: { [name: string]: { enabled: boolean; script: string } };
  };
  security: {
    staging_only: boolean;
    allow_deploy: boolean;
    allowed_mcp_tools: string[];
  };
  context?: {
    choreography?: boolean;   // master switch for the choreography layer (default true)
    review_tag?: string;      // tag that signals a spec has been cross-reviewed (default codex-review)
    stages?: string[];        // which choreography stages are active (default: all)
  };
  session?: {
    auto_close_minutes?: number;
    max_duration_hours?: number;
  };
  monitoring?: {
    health_schedule?: string;
    alert_on?: string[];
    telegram_chat_id?: string;
  };
}

export interface TierConfig {
  provider: string;
  model: string;
  max_context_tokens?: number;
  base_url?: string;
  api_key_env?: string;
}

/**
 * A single advisory choreography nudge: "what the workflow expects next".
 * Derived from ledger + doc state at compile time. Advisory only —
 * memnant emits it, the host agent acts on it.
 */
export interface ProcessNudge {
  stage: string;
  message: string;
  refs?: string[];
}

export interface CompiledContext {
  token_estimate: number;
  warnings: string[];
  sections: {
    last_session: string | null;
    open_todos: string[];
    epic_context: string | null;
    framework_fixes: string[];
    spec_constraints: string[];
    persona_tests: string[];
    stale_decisions: string[];
    project_understanding?: string[];
    superseded_decisions?: string[];
    contradictions?: string[];
    override_suggestions?: string[];
    preferences?: string[];
    review_pressure?: string[];
    assumptions?: string[];
    team_decisions?: string[];
    team_updates?: string[];
    colony_patterns?: string[];
    sibling_decisions?: string[];
    sibling_fixes?: string[];
    process_guidance?: ProcessNudge[];
  };
}

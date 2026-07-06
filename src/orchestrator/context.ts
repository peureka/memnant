/**
 * memnant — Tier-appropriate context injection.
 *
 * Story 4.1/4.3: Builds context for each tier with token budgets.
 *
 * Tier 1: project name, last session summary (first 500 tokens), session status
 * Tier 2: Tier 1 + up to 5 relevant decisions + applicable spec constraints
 * Tier 3: full compiled session context
 */

import type { Database } from '../ledger/database.js';
import type { TierNumber } from './router.js';
import type { ProjectConfig } from '../types.js';
import { getLastClosedSession } from '../ledger/sessions.js';
import { getActiveSession } from '../ledger/sessions.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { searchRecords } from '../vector/search.js';
import { compileContext, formatContextAsMarkdown } from '../context/compile.js';

export interface InjectedContext {
  systemPrompt: string;
  recordCount: number;
  tokenEstimate: number;
}

/**
 * Build tier-appropriate context for injection into a model call.
 */
export async function buildTierContext(
  db: Database,
  config: ProjectConfig,
  tier: TierNumber,
  message: string,
  docsPath: string,
  projectRoot: string,
): Promise<InjectedContext> {
  const maxTokens = getTierTokenBudget(config, tier);

  switch (tier) {
    case 1:
      return buildTier1Context(db, config, maxTokens);
    case 2:
      return buildTier2Context(db, config, message, docsPath, maxTokens);
    case 3:
      return buildTier3Context(db, config, docsPath, projectRoot, maxTokens);
  }
}

function getTierTokenBudget(config: ProjectConfig, tier: TierNumber): number {
  switch (tier) {
    case 1: return config.orchestrator.tiers.triage.max_context_tokens ?? 2000;
    case 2: return config.orchestrator.tiers.analysis.max_context_tokens ?? 8000;
    case 3: return config.orchestrator.tiers.build.max_context_tokens ?? 32000;
  }
}

/**
 * Tier 1: Minimal context — project name, last session summary, session status.
 */
function buildTier1Context(
  db: Database,
  config: ProjectConfig,
  maxTokens: number,
): InjectedContext {
  const parts: string[] = [];
  parts.push(`Project: ${config.project.name}`);

  const active = getActiveSession(db, config.project.id);
  if (active) {
    parts.push(`Active session: ${active.id.slice(0, 8)} (started ${active.started_at.slice(0, 19)})`);
    if (active.epic) parts.push(`Epic: ${active.epic}`);
  } else {
    parts.push('No active session.');
  }

  const lastSession = getLastClosedSession(db);
  if (lastSession?.log_record_id) {
    const logRecord = db.get(
      'SELECT content_text FROM record WHERE id = ?',
      [lastSession.log_record_id],
    ) as unknown as { content_text: string } | undefined;
    if (logRecord) {
      // Truncate to ~500 tokens (2000 chars)
      const summary = logRecord.content_text.slice(0, 2000);
      parts.push(`\nLast session summary:\n${summary}`);
    }
  }

  const text = truncateToTokenBudget(parts.join('\n'), maxTokens);
  return {
    systemPrompt: wrapContext(text),
    recordCount: lastSession?.log_record_id ? 1 : 0,
    tokenEstimate: estimateTokens(text),
  };
}

/**
 * Tier 2: Moderate context — Tier 1 + relevant decisions + spec constraints.
 */
async function buildTier2Context(
  db: Database,
  config: ProjectConfig,
  message: string,
  docsPath: string,
  maxTokens: number,
): Promise<InjectedContext> {
  const tier1 = buildTier1Context(db, config, maxTokens);
  const parts: string[] = [tier1.systemPrompt.replace(/<\/?memnant_context>/g, '')];
  let recordCount = tier1.recordCount;

  // Search for relevant decisions
  const queryEmbedding = await generateEmbedding(message);
  const results = searchRecords(db, queryEmbedding, {
    type: 'decision',
    limit: 5,
  });

  if (results.length > 0) {
    parts.push('\nRelevant decisions:');
    for (const r of results) {
      const shortId = r.id.slice(0, 8);
      const date = r.created_at.slice(0, 10);
      parts.push(`[${shortId}] (${date}) ${r.content_text.slice(0, 500)}`);
      recordCount++;
    }
  }

  // Search for relevant framework fixes
  const fwResults = searchRecords(db, queryEmbedding, {
    type: 'framework_fix',
    limit: 3,
  });

  if (fwResults.length > 0) {
    parts.push('\nRelevant framework fixes:');
    for (const r of fwResults) {
      const shortId = r.id.slice(0, 8);
      const date = r.created_at.slice(0, 10);
      parts.push(`[${shortId}] (${date}) ${r.content_text.slice(0, 300)}`);
      recordCount++;
    }
  }

  const text = truncateToTokenBudget(parts.join('\n'), maxTokens);
  return {
    systemPrompt: wrapContext(text),
    recordCount,
    tokenEstimate: estimateTokens(text),
  };
}

/**
 * Tier 3: Full context — compiled session context.
 */
async function buildTier3Context(
  db: Database,
  config: ProjectConfig,
  docsPath: string,
  projectRoot: string,
  maxTokens: number,
): Promise<InjectedContext> {
  const ctx = await compileContext(db, { docsPath, projectRoot, builder: config.project.builder });
  const markdown = formatContextAsMarkdown(ctx);

  const text = truncateToTokenBudget(markdown, maxTokens);
  const recordCount =
    ctx.sections.open_todos.length +
    ctx.sections.framework_fixes.length +
    ctx.sections.spec_constraints.length +
    ctx.sections.persona_tests.length +
    ctx.sections.stale_decisions.length +
    (ctx.sections.last_session ? 1 : 0) +
    (ctx.sections.epic_context ? 1 : 0);

  return {
    systemPrompt: wrapContext(text),
    recordCount,
    tokenEstimate: estimateTokens(text),
  };
}

function wrapContext(text: string): string {
  return `<memnant_context>\n${text}\n</memnant_context>`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[Context truncated to fit token budget]';
}

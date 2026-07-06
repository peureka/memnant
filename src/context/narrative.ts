/**
 * Narrative briefing — template-based context rendering.
 *
 * Delta-focused: only shows what changed. Omits empty sections.
 * Reads like a colleague catching you up, not a database dump.
 */

import type { CompiledContext } from '../types.js';

export interface BriefingOptions {
  daysSinceLastSession: number;
  colonyFixes?: string[];
  patterns?: string[];
}

export function renderTemplateBriefing(ctx: CompiledContext, opts: BriefingOptions): string {
  const lines: string[] = [];

  // Time away
  const days = opts.daysSinceLastSession;
  if (days > 0) {
    lines.push(days === 1
      ? '1 day since last session.'
      : `${days} days since last session.`
    );
    lines.push('');
  }

  // Last session (always show if present)
  if (ctx.sections.last_session) {
    lines.push('Last session:');
    lines.push(ctx.sections.last_session);
    lines.push('');
  }

  // Open TODOs
  if (ctx.sections.open_todos.length > 0) {
    lines.push(`Open TODOs (${ctx.sections.open_todos.length}):`);
    for (const todo of ctx.sections.open_todos) {
      lines.push(`  - ${todo}`);
    }
    lines.push('');
  }

  // Stale decisions
  if (ctx.sections.stale_decisions.length > 0) {
    lines.push(`Needs attention — ${ctx.sections.stale_decisions.length} stale:`);
    for (const s of ctx.sections.stale_decisions) {
      lines.push(`  ${s}`);
    }
    lines.push('');
  }

  // Framework fixes (project)
  if (ctx.sections.framework_fixes.length > 0) {
    lines.push('Framework fixes:');
    for (const f of ctx.sections.framework_fixes) {
      lines.push(`  ${f}`);
    }
    lines.push('');
  }

  // Team decisions (from other builders)
  if (ctx.sections.team_decisions && ctx.sections.team_decisions.length > 0) {
    lines.push('Team decisions:');
    for (const d of ctx.sections.team_decisions) {
      lines.push(`  ${d}`);
    }
    lines.push('');
  }

  // Team updates (stigmergy)
  if (ctx.sections.team_updates && ctx.sections.team_updates.length > 0) {
    lines.push('Team updates:');
    for (const u of ctx.sections.team_updates) {
      lines.push(`  ${u}`);
    }
    lines.push('');
  }

  // Colony fixes (cross-project)
  if (opts.colonyFixes && opts.colonyFixes.length > 0) {
    lines.push('From other projects:');
    for (const f of opts.colonyFixes) {
      lines.push(`  ${f}`);
    }
    lines.push('');
  }

  // Patterns
  if (opts.patterns && opts.patterns.length > 0) {
    lines.push('Patterns:');
    for (const p of opts.patterns) {
      lines.push(`  ${p}`);
    }
    lines.push('');
  }

  // Colony patterns (confirmed across projects)
  if (ctx.sections.colony_patterns && ctx.sections.colony_patterns.length > 0) {
    lines.push('Colony patterns (confirmed across projects):');
    for (const p of ctx.sections.colony_patterns) {
      lines.push(`  ${p}`);
    }
    lines.push('');
  }

  // Decision churn
  if (ctx.sections.churn_alerts && ctx.sections.churn_alerts.length > 0) {
    lines.push('Decision churn:');
    for (const a of ctx.sections.churn_alerts) {
      lines.push(`  ${a}`);
    }
    lines.push('');
  }

  // Override suggestions
  if (ctx.sections.override_suggestions && ctx.sections.override_suggestions.length > 0) {
    lines.push('Override suggestions:');
    for (const o of ctx.sections.override_suggestions) {
      lines.push(`  ${o}`);
    }
    lines.push('');
  }

  // Warnings
  if (ctx.warnings.length > 0) {
    for (const w of ctx.warnings) {
      lines.push(`Warning: ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

const BRIEFING_SYSTEM_PROMPT = `You are catching up a returning developer. Be concise, direct, conversational.
Don't list records — tell a story. What happened, what changed, what needs attention.
Under 300 words. Lead with what matters most.`;

export function buildBriefingPrompt(ctx: CompiledContext, opts: BriefingOptions): string {
  const lines: string[] = [];
  lines.push(`Developer returning after ${opts.daysSinceLastSession} days.`);
  lines.push('');
  lines.push('Raw context to compose into a narrative:');
  lines.push('');
  lines.push(renderTemplateBriefing(ctx, opts));
  return lines.join('\n');
}

export interface LlmBriefingResult {
  text: string;
  fallback: boolean;
}

export async function composeLlmBriefing(
  ctx: CompiledContext,
  opts: BriefingOptions & { tierConfig: any | null },
): Promise<LlmBriefingResult> {
  if (!opts.tierConfig) {
    return { text: renderTemplateBriefing(ctx, opts), fallback: true };
  }

  try {
    const { callModel } = await import('../orchestrator/providers.js');
    const prompt = buildBriefingPrompt(ctx, opts);
    const response = await callModel(opts.tierConfig, BRIEFING_SYSTEM_PROMPT, prompt);
    return { text: response.text, fallback: false };
  } catch {
    return { text: renderTemplateBriefing(ctx, opts), fallback: true };
  }
}

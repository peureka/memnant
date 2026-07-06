/**
 * memnant — Dynamic project brief.
 *
 * Story 12.3: 500-token dynamic brief that summarises current project state.
 * Story 14.1: Includes active spec constraints filtered by context.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig } from '../types.js';
import { autoDetectEpic } from './branch.js';
import { getValidSyntheses } from '../synthesis/cache.js';
import { getUnresolvedContradictions } from '../graph/relationships.js';
import { getSupersededRecordIds } from '../graph/relationships.js';
import { scanSpecs, extractSpecDetail, type SpecDocument } from '../governor/specs.js';
import { existsSync } from 'fs';
import { join } from 'path';

export interface ProjectBrief {
  project_name: string;
  current_epic: string | null;
  understandings: string[];
  warnings: string[];
  framework_fixes: string[];
  constraints: string[];
  token_estimate: number;
}

/**
 * Generate a dynamic project brief (~500 tokens).
 * Fresh on every call, not cached.
 */
export function generateProjectBrief(
  db: Database,
  config: ProjectConfig,
  projectRoot: string,
): ProjectBrief {
  const parts: string[] = [];

  // 1. Project name
  const projectName = config.project.name;
  parts.push(projectName);

  // 2. Current epic (from branch)
  const currentEpic = autoDetectEpic(projectRoot);
  if (currentEpic) {
    parts.push(`Current work: ${currentEpic}`);
  }

  // 3. Top synthesised understandings (from cache)
  const syntheses = getValidSyntheses(db);
  const understandings = syntheses.slice(0, 3).map((s) => s.synthesis.split('\n')[0].slice(0, 150));

  // 4. Active warnings (contradictions, stale count)
  const warnings: string[] = [];

  const contradictions = getUnresolvedContradictions(db);
  if (contradictions.length > 0) {
    warnings.push(`${contradictions.length} unresolved contradiction(s)`);
  }

  // Check stale count
  const staleDecisions = db.all(
    "SELECT COUNT(*) as count FROM record WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL",
  ) as unknown as Array<{ count: number }>;
  // We'd need staleness check here but that's expensive — just note the count
  const totalDecisions = staleDecisions[0]?.count ?? 0;
  if (totalDecisions > 0) {
    parts.push(`${totalDecisions} decision(s) in ledger`);
  }

  // 5. Today's relevant framework fixes (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentFixes = db.all(
    `SELECT content_text FROM record
     WHERE type = 'framework_fix' AND created_at > ?
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT 3`,
    [weekAgo],
  ) as unknown as Array<{ content_text: string }>;

  const frameworkFixes = recentFixes.map((r) => r.content_text.split('\n')[0].slice(0, 100));

  // 6. Active constraints from specs (Story 14.1)
  const constraints = getActiveConstraints(config, projectRoot, currentEpic);

  const brief: ProjectBrief = {
    project_name: projectName,
    current_epic: currentEpic,
    understandings,
    warnings,
    framework_fixes: frameworkFixes,
    constraints,
    token_estimate: 0,
  };

  // Estimate tokens
  const fullText = [
    projectName,
    currentEpic ?? '',
    ...understandings,
    ...warnings,
    ...frameworkFixes,
    ...constraints,
  ].join(' ');
  brief.token_estimate = Math.ceil(fullText.length / 4);

  return brief;
}

/**
 * Format the brief as markdown.
 */
export function formatBriefAsMarkdown(brief: ProjectBrief): string {
  const parts: string[] = [];

  parts.push(`# ${brief.project_name}`);
  if (brief.current_epic) {
    parts.push(`**Current:** ${brief.current_epic}`);
  }
  parts.push('');

  if (brief.understandings.length > 0) {
    parts.push('**Project understanding:**');
    for (const u of brief.understandings) {
      parts.push(`- ${u}`);
    }
    parts.push('');
  }

  if (brief.warnings.length > 0) {
    parts.push('**Warnings:**');
    for (const w of brief.warnings) {
      parts.push(`- ${w}`);
    }
    parts.push('');
  }

  if (brief.framework_fixes.length > 0) {
    parts.push('**Recent fixes:**');
    for (const f of brief.framework_fixes) {
      parts.push(`- ${f}`);
    }
    parts.push('');
  }

  if (brief.constraints.length > 0) {
    parts.push('**Active constraints:**');
    for (const c of brief.constraints) {
      parts.push(`- ${c}`);
    }
  }

  return parts.join('\n');
}

/**
 * Get active spec constraints filtered by current context.
 * Max 200 tokens worth.
 */
function getActiveConstraints(
  config: ProjectConfig,
  projectRoot: string,
  epic: string | null,
): string[] {
  const docsPath = join(projectRoot, config.governor.docs_path);
  if (!existsSync(docsPath)) return [];

  let specs: SpecDocument[];
  try {
    specs = scanSpecs(docsPath);
  } catch {
    return [];
  }

  const constraints: string[] = [];
  let charBudget = 800; // ~200 tokens

  for (const spec of specs) {
    // Filter by epic if applicable
    if (epic && spec.frontmatter.applies_to) {
      const targets = Array.isArray(spec.frontmatter.applies_to)
        ? spec.frontmatter.applies_to
        : [spec.frontmatter.applies_to];
      const matches = targets.some((t) => t === 'all' || t.toLowerCase().includes(epic.toLowerCase()));
      if (!matches) continue;
    }

    const detail = extractSpecDetail(spec);

    // Add banned items as constraints
    for (const banned of detail.banned) {
      const constraint = `Do not use "${banned.term}"${banned.replacement ? ` — use "${banned.replacement}" instead` : ''}`;
      if (charBudget - constraint.length < 0) break;
      constraints.push(constraint);
      charBudget -= constraint.length;
    }

    if (charBudget <= 0) break;
  }

  return constraints;
}

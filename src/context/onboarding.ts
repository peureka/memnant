/**
 * memnant — Onboarding brief.
 *
 * Story 15.4: Compile a structured onboarding package from the ledger
 * with 6 sections and an 8000-token budget.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig } from '../types.js';
import { generateProjectBrief, formatBriefAsMarkdown } from './brief.js';

const DEFAULT_TOKEN_BUDGET = 8000;
const CHARS_PER_TOKEN = 4;

export interface OnboardingBrief {
  project_name: string;
  sections: {
    project_brief: string;
    key_decisions: string[];
    architecture_patterns: string[];
    known_gotchas: string[];
    team_conventions: string[];
    current_work: string[];
  };
  stale_knowledge: string[];
  token_estimate: number;
}

export function compileOnboardingBrief(
  db: Database,
  config: ProjectConfig,
  projectRoot: string,
  options?: { full?: boolean },
): OnboardingBrief {
  const budget = options?.full ? Infinity : DEFAULT_TOKEN_BUDGET;
  let charBudget = budget * CHARS_PER_TOKEN;

  // 1. Project brief
  const brief = generateProjectBrief(db, config, projectRoot);
  const projectBriefText = formatBriefAsMarkdown(brief);
  charBudget -= projectBriefText.length;

  const sectionBudget = Math.floor(Math.max(charBudget, 0) / 5);

  // 2. Key decisions — top 20 active by recency
  const decisions = db.all(
    `SELECT id, content_text, builder_id, created_at FROM record
     WHERE type = 'decision'
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT 20`,
  ) as any[];

  const keyDecisions: string[] = [];
  let decBudget = sectionBudget;
  for (const d of decisions) {
    const builder = d.builder_id ? ` [${d.builder_id}]` : '';
    const line = `[${d.id.slice(0, 8)}${builder}] ${d.content_text.split('\n')[0].slice(0, 150)}`;
    if (decBudget - line.length < 0) break;
    keyDecisions.push(line);
    decBudget -= line.length;
  }

  // 3. Architecture patterns
  const patterns = db.all(
    `SELECT content_text FROM record
     WHERE type = 'pattern'
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY pattern_strength DESC LIMIT 10`,
  ) as any[];

  const architecturePatterns: string[] = [];
  let patBudget = sectionBudget;
  for (const p of patterns) {
    const line = p.content_text.split('\n')[0].slice(0, 150);
    if (patBudget - line.length < 0) break;
    architecturePatterns.push(line);
    patBudget -= line.length;
  }

  // 4. Known gotchas
  const fixes = db.all(
    `SELECT id, content_text, builder_id FROM record
     WHERE type = 'framework_fix'
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT 15`,
  ) as any[];

  const knownGotchas: string[] = [];
  let fixBudget = sectionBudget;
  for (const f of fixes) {
    const builder = f.builder_id ? ` [${f.builder_id}]` : '';
    const line = `[${f.id.slice(0, 8)}${builder}] ${f.content_text.split('\n')[0].slice(0, 150)}`;
    if (fixBudget - line.length < 0) break;
    knownGotchas.push(line);
    fixBudget -= line.length;
  }

  // 5. Team conventions — decisions agreed on by multiple builders
  const conventions: string[] = [];
  const conventionRows = db.all(
    `SELECT DISTINCT r1.content_text, r1.builder_id as b1, r2.builder_id as b2
     FROM record r1
     JOIN record_relationship rr ON rr.source_record_id = r1.id
     JOIN record r2 ON rr.target_record_id = r2.id
     WHERE r1.type = 'decision' AND r2.type = 'decision'
       AND r1.builder_id IS NOT NULL AND r2.builder_id IS NOT NULL
       AND r1.builder_id != r2.builder_id
       AND rr.type = 'related' AND rr.dismissed_at IS NULL
       AND r1.retracted_at IS NULL AND r1.archived_at IS NULL
     LIMIT 10`,
  ) as any[];

  let convBudget = sectionBudget;
  for (const c of conventionRows) {
    const line = `${c.content_text.split('\n')[0].slice(0, 120)} (${c.b1}, ${c.b2})`;
    if (convBudget - line.length < 0) break;
    conventions.push(line);
    convBudget -= line.length;
  }

  // 6. Current work state
  const sessionLogs = db.all(
    `SELECT content_text, builder_id, created_at FROM record
     WHERE type = 'session_log'
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at DESC LIMIT 5`,
  ) as any[];

  const currentWork: string[] = [];
  let workBudget = sectionBudget;
  for (const s of sessionLogs) {
    const builder = s.builder_id ? ` [${s.builder_id}]` : '';
    const date = s.created_at.slice(0, 10);
    const line = `${date}${builder}: ${s.content_text.split('\n')[0].slice(0, 120)}`;
    if (workBudget - line.length < 0) break;
    currentWork.push(line);
    workBudget -= line.length;
  }

  // Stale knowledge — oldest active decisions that may need review
  const staleDecisions = db.all(
    `SELECT id, content_text FROM record
     WHERE type = 'decision'
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at ASC LIMIT 10`,
  ) as any[];

  const staleKnowledge = staleDecisions.map((d: any) =>
    `[${d.id.slice(0, 8)}] ${d.content_text.split('\n')[0].slice(0, 100)}`,
  );

  // Token estimate
  const allText = [
    projectBriefText, ...keyDecisions, ...architecturePatterns,
    ...knownGotchas, ...conventions, ...currentWork, ...staleKnowledge,
  ].join(' ');
  const tokenEstimate = Math.ceil(allText.length / CHARS_PER_TOKEN);

  return {
    project_name: config.project.name,
    sections: {
      project_brief: projectBriefText,
      key_decisions: keyDecisions,
      architecture_patterns: architecturePatterns,
      known_gotchas: knownGotchas,
      team_conventions: conventions,
      current_work: currentWork,
    },
    stale_knowledge: staleKnowledge,
    token_estimate: tokenEstimate,
  };
}

export function formatOnboardingBrief(brief: OnboardingBrief): string {
  const lines: string[] = [];
  lines.push(`# Onboarding: ${brief.project_name}`);
  lines.push('');
  lines.push(brief.sections.project_brief);
  lines.push('');

  if (brief.sections.key_decisions.length > 0) {
    lines.push('## Key Decisions');
    for (const d of brief.sections.key_decisions) lines.push(`- ${d}`);
    lines.push('');
  }
  if (brief.sections.architecture_patterns.length > 0) {
    lines.push('## Architecture Patterns');
    for (const p of brief.sections.architecture_patterns) lines.push(`- ${p}`);
    lines.push('');
  }
  if (brief.sections.known_gotchas.length > 0) {
    lines.push('## Known Gotchas');
    for (const g of brief.sections.known_gotchas) lines.push(`- ${g}`);
    lines.push('');
  }
  if (brief.sections.team_conventions.length > 0) {
    lines.push('## Team Conventions');
    for (const c of brief.sections.team_conventions) lines.push(`- ${c}`);
    lines.push('');
  }
  if (brief.sections.current_work.length > 0) {
    lines.push('## Current Work');
    for (const w of brief.sections.current_work) lines.push(`- ${w}`);
    lines.push('');
  }
  if (brief.stale_knowledge.length > 0) {
    lines.push('## Stale Knowledge (review with caution)');
    for (const s of brief.stale_knowledge) lines.push(`- ${s}`);
    lines.push('');
  }
  lines.push('---');
  lines.push(`Token estimate: ~${brief.token_estimate}`);
  return lines.join('\n');
}

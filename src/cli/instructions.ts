/**
 * memnant instructions — Output agent instruction snippets.
 *
 * Generates markdown that tells an AI agent how to use memnant's MCP tools.
 *
 * Epic 7: Composable sections for instinctive logging patterns.
 * Story 8.3: Session close instructions for agents.
 */

import { Command } from 'commander';

async function getProjectInfo(): Promise<{ name: string; dbPath: string } | null> {
  const { loadConfig, findProjectRoot } = await import('../config/load.js');
  const cwd = process.cwd();
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return null;
  try {
    const config = loadConfig(projectRoot);
    return { name: config.project.name, dbPath: config.memory.db_path };
  } catch {
    return null;
  }
}

// --- Composable instruction sections ---

export function sectionMcpTools(): string {
  return `## MCP Tools

- \`recall\` — Search prior decisions before making new ones
- \`log\` — Record decisions, framework fixes, session logs
- \`session_context\` — Get compiled context at session start
- \`session_log\` — Log a progress summary (session stays active)
- \`session_close\` — Close the session with a summary log
- \`status\` — Check project health and staleness
- \`check_copy\` — Validate text against copy specs
- \`check_design\` — Validate against design system specs
- \`synthesise\` — Ask a question that spans multiple records
- \`context_for_file\` — Get records relevant to a specific file
- \`project_brief\` — Get a 500-token dynamic project brief
`;
}

export function sectionWorkflow(): string {
  return `## Workflow

1. Call \`project_brief\` or \`session_context\` at the start of every session
2. Log decisions and framework fixes as they happen (see Instinctive Logging below)
3. Call \`session_log\` when the human says "done" — call \`session_close\` only when they explicitly say "close session"
`;
}

export function sectionDecisionDetection(): string {
  return `## Instinctive Logging: Decisions

When you make or confirm a decision during work, log it silently — no announcement needed.

**Patterns to detect:**
- "Let's go with X" / "We'll use X"
- "X over Y because..." — comparative evaluations that resolve
- Architecture choices, technology selections, API design decisions
- Any choice between alternatives that has a rationale

**How to log:**
Call \`log\` with type \`decision\`. Structure the content as:
- **Question:** What was being decided?
- **Context:** What constraints or factors applied?
- **Decision:** What was chosen?
- **Rationale:** Why?

Log silently. Do not say "I'm logging this decision" — just log it.
`;
}

export function sectionFrameworkFixDetection(): string {
  return `## Instinctive Logging: Framework Fixes

When you encounter an error, research it, find the fix, and verify it works — log the fix.

**Pattern:** error → research → fix → verify works
**Timing:** Log AFTER verification, not on first error. Only log fixes that actually work.

**How to log:**
Call \`log\` with type \`framework_fix\`. Auto-tag with the framework/library name.
Content: Problem → Environment → Solution → Verification.

Log after the fix is confirmed working. Do not log speculative fixes.
`;
}

export function sectionProductDecisionDetection(): string {
  return `## Instinctive Logging: Product Decisions

When a product, positioning, or messaging decision is made during conversation, log it the same way as code decisions — silently, as a \`decision\` with product-specific tags.

**Patterns to detect:**
- "Our positioning is..." / "We're positioning as..."
- "The messaging should..." / "The tagline is X because..."
- "We're differentiating on..." / "The competitive gap is..."
- "Competitors can't do X" / "What sets us apart is..."
- "The target user is... because..."
- "We chose X positioning over Y because..."
- Pricing decisions, naming decisions, audience refinements

**How to log:**
Call \`log\` with type \`decision\`. Tag with \`product\` plus a category: \`positioning\`, \`messaging\`, \`competitive-intel\`, \`pricing\`, or \`target-audience\`.

Structure the content as:
- **What:** The product decision
- **Why:** Reasoning, competitive context, user insight
- **Over:** Alternatives considered
- **Evidence:** Key facts that supported the decision

**Competitive analysis:** When competitive context comes up — what competitors do, what they can't do, market gaps — log it as a \`decision\` tagged \`competitive-intel\`. The connection graph will auto-link it to related positioning decisions.

Log silently. Same density as code decisions: 1-3 sentences, facts not narrative.
`;
}

export function sectionRejectionLogging(): string {
  return `## Instinctive Logging: Rejections

When an approach is tried and rejected, log it so future sessions don't repeat the mistake.

**Patterns to detect:**
- "That didn't work because..."
- "Tried X but..." followed by reverting
- An approach that was implemented then rolled back
- A library/tool evaluated then discarded

**How to log:**
Call \`log\` with type \`decision\` and tag \`rejected\`.
Content: Approach → Why rejected → What worked instead.
`;
}

export function sectionLoggingTasteGuide(): string {
  return `## Logging Taste Guide

**Worth logging:**
- Architecture decisions (database choice, API patterns, state management)
- Technology choices (libraries, frameworks, services)
- Framework gotchas that took >5 minutes to solve
- Rejected approaches (so they aren't retried)
- Spec constraints discovered during work
- Positioning decisions (why this angle, what competitors can't do)
- Messaging choices (tagline rationale, value prop evolution)
- Competitive analysis (market gaps, feature comparisons)

**Not worth logging:**
- Code formatting preferences (use linter config)
- Routine code that's obvious from the diff
- Trivially reversible changes
- Information already captured in git history

**Threshold:** Would a returning developer 3 weeks from now need this?

**Density:** 1-3 sentences per record. Dense, not verbose. Facts, not narrative.
`;
}

export function sectionSessionClose(): string {
  return `## Session Log vs Session Close

**\`session_log\`** — Log progress without ending the session. Use when the human says "done", "that's it for now", "let's wrap up this part", or signals a milestone. The session stays active.

**\`session_close\`** — Log AND end the session. Use only when the human explicitly says "close session", "session close", or "end session".

**Default to \`session_log\`.** Most "done" signals mean "done with this task", not "end the session".

**Summary template (for both):**
- **Shipped:** What was completed
- **Decisions:** Key choices made and why
- **Rejected:** Approaches tried and abandoned
- **Gotchas:** Framework issues, unexpected behaviour
- **TODOs:** What's next, what was deferred

No permission needed — just log. The human expects it.
`;
}

// --- Full instruction generators ---

function genericInstructions(project: { name: string; dbPath: string } | null): string {
  const projectLine = project
    ? `Project: **${project.name}** (ledger: \`${project.dbPath}\`)`
    : 'Project: not initialised — run `memnant init` first';

  return `# memnant — Agent Instructions

${projectLine}

memnant is configured as an MCP server. Use the following tools to maintain project memory:

## Available Tools

- **recall** — Search the ledger by query, type, or tags. Use this to check for prior decisions before making new ones.
- **log** — Write a record (decision, framework_fix, session_log). Log every significant decision.
- **session_context** — Get compiled context for the current session. Call this at the start of every work session.
- **session_log** — Log a progress summary without closing the session.
- **session_close** — Close the session with a summary log.
- **status** — Check project health: record count, session state, staleness warnings.
- **check_copy** — Validate text against copy audit specs (banned/discouraged phrases).
- **check_design** — Validate content against design system specs.

## Session Workflow

1. **Start of session:** Call \`session_context\` to get prior decisions, open TODOs, and framework fixes.
2. **During work:** Call \`log\` for every decision, trade-off, or framework discovery.
3. **Milestone or "done":** Call \`session_log\` with a summary of what shipped, decisions, and TODOs.
4. **End of session:** Call \`session_close\` only when the human explicitly says "close session" or "end session".

${sectionDecisionDetection()}
${sectionProductDecisionDetection()}
${sectionFrameworkFixDetection()}
${sectionRejectionLogging()}
${sectionLoggingTasteGuide()}
${sectionSessionClose()}`;
}

export function claudeCodeInstructions(project: { name: string; dbPath: string } | null): string {
  const projectLine = project
    ? `Project: ${project.name} (ledger: ${project.dbPath})`
    : 'Project: not initialised — run `memnant init` first';

  return `# memnant

${projectLine}

memnant is available as an MCP server. Use it for institutional memory.

${sectionWorkflow()}
${sectionDecisionDetection()}
${sectionProductDecisionDetection()}
${sectionFrameworkFixDetection()}
${sectionRejectionLogging()}
${sectionLoggingTasteGuide()}
${sectionSessionClose()}
${sectionMcpTools()}`;
}

function codexInstructions(project: { name: string; dbPath: string } | null): string {
  const projectLine = project
    ? `Project: ${project.name} (ledger: ${project.dbPath})`
    : 'Project: not initialised — run `memnant init` first';

  return `# memnant

${projectLine}

memnant is available as an MCP server for institutional memory.

${sectionMcpTools()}
${sectionWorkflow()}
${sectionDecisionDetection()}
${sectionProductDecisionDetection()}
${sectionFrameworkFixDetection()}
${sectionRejectionLogging()}
${sectionLoggingTasteGuide()}
${sectionSessionClose()}`;
}

export function registerInstructionsCommand(program: Command): void {
  program
    .command('instructions')
    .description('Output agent instructions for using memnant')
    .option('--tool <tool>', 'Format for a specific tool (claude-code, codex)')
    .action(async (opts: { tool?: string }) => {
      const project = await getProjectInfo();

      if (opts.tool === 'claude-code') {
        process.stdout.write(claudeCodeInstructions(project));
      } else if (opts.tool === 'codex') {
        process.stdout.write(codexInstructions(project));
      } else if (opts.tool) {
        console.error(`Unknown tool '${opts.tool}'. Valid tools: claude-code, codex`);
        process.exit(1);
      } else {
        process.stdout.write(genericInstructions(project));
      }
    });
}

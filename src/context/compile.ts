/**
 * memnant — Context compilation.
 *
 * Story 2.1: Compiles a context package from the ledger and docs.
 * This is the core of the "3-week Monday morning" experience.
 *
 * Compilation steps (in order):
 * 1. Last session summary
 * 2. Open TODOs from recent session logs
 * 3. Epic context (decisions mentioning the epic)
 * 4. Framework fixes (5 most recent, filtered by epic)
 * 5. Spec constraints (from docs with matching frontmatter)
 * 6. Persona tests (from docs with type: persona)
 */

import type { Database } from '../ledger/database.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { CompiledContext } from '../types.js';
import { getLastClosedSession } from '../ledger/sessions.js';
import {
  scanProject,
  diffSnapshots,
  getLastSnapshot,
  getLastSnapshotDate,
  getChangedPaths,
  getChangedDeps,
  type SnapshotDiff,
} from '../snapshot/scanner.js';
import { autoDetectEpic } from './branch.js';
import { getOverrideSuggestions } from '../governor/overrides.js';
import { computeAstHashForRecord } from '../ast/parser.js';
import { snapshotSpecIfChanged } from './spec-diff.js';
import { scanSpecs } from '../governor/specs.js';
import { dotProduct } from '../vector/search.js';
import { deserializeEmbedding } from '../vector/embedding-utils.js';

export interface CompileOptions {
  epic?: string;
  docsPath: string;
  projectRoot?: string;
  projectId?: string;
  builder?: string;  // Current builder name — enables team decisions section
}

interface RecordRow {
  id: string;
  type: string;
  content_text: string;
  created_at: string;
  tags: string;
}

export async function compileContext(db: Database, opts: CompileOptions): Promise<CompiledContext> {
  const warnings: string[] = [];

  // Auto-detect epic from branch if not provided (Story 12.2)
  if (!opts.epic && opts.projectRoot) {
    const detectedEpic = autoDetectEpic(opts.projectRoot);
    if (detectedEpic) {
      opts.epic = detectedEpic;
    }
  }

  // 1. Last session summary
  const lastSession = getLastClosedSession(db);
  let lastSessionText: string | null = null;

  if (lastSession) {
    if (lastSession.log_skipped) {
      const date = lastSession.closed_at?.slice(0, 10) ?? 'unknown';
      warnings.push(
        `\u26a0 Previous session (${date}) has no log. Context from that session is not available. You may have blind spots.`,
      );
    } else if (lastSession.log_record_id) {
      const logRecord = db.get(
        'SELECT content_text FROM record WHERE id = ?',
        [lastSession.log_record_id],
      ) as unknown as { content_text: string } | undefined;
      lastSessionText = logRecord?.content_text ?? null;
    }
  }

  // 2. Open TODOs from last 3 session logs
  const recentLogs = db.all(
    `SELECT content_text FROM record
     WHERE type = 'session_log' AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at DESC
     LIMIT 3`,
  ) as unknown as Array<{ content_text: string }>;

  const openTodos: string[] = [];
  for (const log of recentLogs) {
    const todos = extractTodos(log.content_text);
    openTodos.push(...todos);
  }

  // 3. Epic context
  let epicContext: string | null = null;
  if (opts.epic) {
    const epicRecords = db.all(
      `SELECT id, type, content_text, created_at, tags FROM record
       WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL
         AND (tags LIKE ? OR content_text LIKE ?)
       ORDER BY created_at DESC`,
      [`%${opts.epic}%`, `%${opts.epic}%`],
    ) as unknown as RecordRow[];

    if (epicRecords.length > 0) {
      const lines = epicRecords.map((r) => {
        const shortId = r.id.slice(0, 8);
        const date = r.created_at.slice(0, 10);
        return `- [${shortId}] (${date}) ${r.content_text.slice(0, 200)}`;
      });
      epicContext = `Decisions related to "${opts.epic}":\n${lines.join('\n')}`;
    }
  }

  // 4. Framework fixes (5 most recent, filtered by epic if provided)
  let fwQuery = `SELECT id, type, content_text, created_at, tags FROM record
     WHERE type = 'framework_fix' AND retracted_at IS NULL AND archived_at IS NULL`;
  const fwParams: string[] = [];
  if (opts.epic) {
    fwQuery += ` AND (tags LIKE ? OR content_text LIKE ?)`;
    fwParams.push(`%${opts.epic}%`, `%${opts.epic}%`);
  }
  fwQuery += ` ORDER BY created_at DESC LIMIT 5`;

  const fwRecords = db.all(fwQuery, fwParams) as unknown as RecordRow[];
  const frameworkFixes = fwRecords.map((r) => {
    const shortId = r.id.slice(0, 8);
    const date = r.created_at.slice(0, 10);
    return `[${shortId}] (${date}) ${r.content_text}`;
  });

  // 5. Spec constraints (from docs with matching frontmatter)
  const specConstraints = scanDocsForSpecs(opts.docsPath, opts.epic);

  // Spec change detection — snapshot specs that have changed
  if (opts.projectId && opts.docsPath && existsSync(opts.docsPath)) {
    const allSpecs = scanSpecs(opts.docsPath);
    for (const spec of allSpecs) {
      const fullText = readFileSync(join(opts.docsPath, spec.filename), 'utf-8');
      const result = snapshotSpecIfChanged(
        db, opts.projectId, spec.filename, fullText,
        spec.frontmatter.type, String(spec.frontmatter.version ?? ''),
      );
      if (result.changed && !result.isNew) {
        warnings.push(`Spec changed: ${spec.filename} (run 'memnant spec-diff ${spec.filename}' to see changes)`);
      }
    }
  }

  // 6. Persona tests
  const personaTests = scanDocsForPersonas(opts.docsPath, opts.epic);

  // 7. Staleness detection (file-hash based + AST-anchored)
  const staleDecisions = await detectStaleness(db, opts.projectRoot);
  const astStaleDecisions = await detectAstStaleness(db, opts.projectRoot);
  const allStaleDecisions = [...staleDecisions, ...astStaleDecisions];

  // 8. Override suggestions (Story 14.3)
  const overrideSuggestions = getOverrideSuggestions(db);

  // Team decisions: records from other builders in the last 30 days
  let teamDecisions: string[] = [];
  if (opts.builder) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const teamRows = db.all(
      `SELECT id, builder_id, content_text, created_at FROM record
       WHERE builder_id IS NOT NULL AND builder_id != ?
         AND created_at > ?
         AND retracted_at IS NULL AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 10`,
      [opts.builder, thirtyDaysAgo],
    ) as unknown as Array<{ id: string; builder_id: string; content_text: string; created_at: string }>;

    teamDecisions = teamRows.map((r) =>
      `[${r.id.slice(0, 8)} · ${r.builder_id}] ${r.content_text.split('\n')[0].slice(0, 150)}`,
    );
  }

  // Build the compiled context
  const ctx: CompiledContext = {
    token_estimate: 0,
    warnings,
    sections: {
      last_session: lastSessionText,
      open_todos: openTodos,
      epic_context: epicContext,
      framework_fixes: frameworkFixes,
      spec_constraints: specConstraints,
      persona_tests: personaTests,
      stale_decisions: allStaleDecisions,
      override_suggestions: overrideSuggestions,
      team_decisions: teamDecisions,
    },
  };

  // Estimate tokens (~4 chars per token)
  ctx.token_estimate = Math.ceil(contextToString(ctx).length / 4);

  return ctx;
}

function extractTodos(text: string): string[] {
  const lines = text.split('\n');
  let inTodos = false;
  const todos: string[] = [];

  for (const line of lines) {
    if (/^##\s+TODOs?\s*$/i.test(line)) {
      inTodos = true;
      continue;
    }
    if (inTodos && /^##\s/.test(line)) {
      break; // Next section
    }
    if (inTodos) {
      const trimmed = line.trim();
      if (trimmed && trimmed !== '-' && trimmed !== '*') {
        todos.push(trimmed);
      }
    }
  }

  return todos;
}

interface FrontMatter {
  type?: string;
  applies_to?: string | string[];
  [key: string]: unknown;
}

function parseFrontmatter(content: string): { frontmatter: FrontMatter | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  try {
    // Simple YAML parsing for frontmatter — handles key: value and key: [array]
    const fm: FrontMatter = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) {
        const value = kv[2].trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          fm[kv[1]] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        } else {
          fm[kv[1]] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
    return { frontmatter: fm, body: match[2] };
  } catch {
    return { frontmatter: null, body: content };
  }
}

function matchesEpic(appliesTo: string | string[] | undefined, epic: string | undefined): boolean {
  if (!epic) return true; // No epic filter — include all
  if (!appliesTo) return false;
  const targets = Array.isArray(appliesTo) ? appliesTo : [appliesTo];
  return targets.some((t) => t === 'all' || t.toLowerCase().includes(epic.toLowerCase()));
}

function scanDocsForSpecs(docsPath: string, epic?: string): string[] {
  if (!existsSync(docsPath)) return [];

  const specs: string[] = [];
  let files: string[];
  try {
    files = readdirSync(docsPath).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  for (const file of files) {
    const content = readFileSync(join(docsPath, file), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter) continue;
    if (!frontmatter.applies_to) continue;

    // Spec types that count as constraints
    const specTypes = ['design_system', 'copy_audit', 'data_model', 'product_spec'];
    if (!frontmatter.type || !specTypes.includes(frontmatter.type)) continue;

    if (matchesEpic(frontmatter.applies_to, epic)) {
      const summary = body.trim().slice(0, 500);
      specs.push(`[${file}] ${summary}`);
    }
  }

  return specs;
}

function scanDocsForPersonas(docsPath: string, epic?: string): string[] {
  if (!existsSync(docsPath)) return [];

  const tests: string[] = [];
  let files: string[];
  try {
    files = readdirSync(docsPath).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  for (const file of files) {
    const content = readFileSync(join(docsPath, file), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter) continue;
    if (frontmatter.type !== 'persona') continue;

    if (epic && frontmatter.applies_to && !matchesEpic(frontmatter.applies_to, epic)) {
      continue;
    }

    // Extract test questions — look for lines that end with "?"
    const questions = body
      .split('\n')
      .filter((line) => line.trim().endsWith('?'))
      .map((line) => line.trim())
      .filter((line) => line.length > 10); // Skip trivially short lines

    if (questions.length > 0) {
      tests.push(`[${file}] ${questions.join(' | ')}`);
    }
  }

  return tests;
}

/**
 * Format a stale record description with optional confidence score.
 */
export function formatStaleDescription(
  shortId: string,
  date: string,
  firstLine: string,
  triggers: string[],
  confidence?: number,
): string {
  const confStr = confidence !== undefined ? ` (confidence: ${confidence.toFixed(2)})` : '';
  return `[${shortId}] (${date}) ${firstLine} — triggered by: ${triggers.join(', ')}${confStr}`;
}

/**
 * Detect stale decisions and framework fixes by comparing the latest
 * snapshot against the current codebase state.
 */
async function detectStaleness(db: Database, projectRoot?: string): Promise<string[]> {
  if (!projectRoot) return [];

  const lastSnapshot = getLastSnapshot(db);
  if (!lastSnapshot) return [];

  // Scan current state and diff against last snapshot
  const currentState = scanProject(projectRoot);
  const diff = diffSnapshots(lastSnapshot, currentState);

  const changedPaths = getChangedPaths(diff);
  const changedDeps = getChangedDeps(diff);

  if (changedPaths.length === 0 && changedDeps.length === 0) return [];

  const staleConfidence = await computeStaleRecordIds(db, projectRoot!);
  const stale: string[] = [];

  // Check decision records for mentions of changed file paths
  const decisions = db.all(
    `SELECT id, content_text, created_at FROM record WHERE type = 'decision' AND retracted_at IS NULL AND archived_at IS NULL`,
  ) as unknown as Array<{ id: string; content_text: string; created_at: string }>;

  for (const record of decisions) {
    const triggers = findPathMentions(record.content_text, changedPaths);
    if (triggers.length > 0) {
      const shortId = record.id.slice(0, 8);
      const date = record.created_at.slice(0, 10);
      const firstLine = record.content_text.split('\n')[0].slice(0, 100);
      const confidence = staleConfidence.get(record.id);
      stale.push(formatStaleDescription(shortId, date, firstLine, triggers, confidence));
    }
  }

  // Check framework fixes for mentions of changed dependencies
  if (changedDeps.length > 0) {
    const fixes = db.all(
      `SELECT id, content_text, created_at FROM record WHERE type = 'framework_fix' AND retracted_at IS NULL AND archived_at IS NULL`,
    ) as unknown as Array<{ id: string; content_text: string; created_at: string }>;

    for (const record of fixes) {
      const triggers = findDepMentions(record.content_text, changedDeps);
      if (triggers.length > 0) {
        const shortId = record.id.slice(0, 8);
        const date = record.created_at.slice(0, 10);
        const firstLine = record.content_text.split('\n')[0].slice(0, 100);
        const confidence = staleConfidence.get(record.id) ?? 1.0;
        stale.push(formatStaleDescription(shortId, date, firstLine, triggers.map(t => `dep: ${t}`), confidence));
      }
    }
  }

  return stale;
}

/**
 * Find which changed paths are mentioned in text.
 * Matches exact file paths and directory-level matches.
 */
function findPathMentions(text: string, changedPaths: string[]): string[] {
  const triggers: string[] = [];
  const lowerText = text.toLowerCase();

  for (const path of changedPaths) {
    // Exact path match
    if (lowerText.includes(path.toLowerCase())) {
      triggers.push(path);
      continue;
    }
    // Directory-level match (e.g. "src/components" matches "src/components/Button.tsx")
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir && lowerText.includes(dir.toLowerCase())) {
      triggers.push(path);
    }
  }

  return triggers;
}

/**
 * Find which changed dependencies are mentioned in text.
 */
function findDepMentions(text: string, changedDeps: string[]): string[] {
  const triggers: string[] = [];
  const lowerText = text.toLowerCase();

  for (const dep of changedDeps) {
    if (lowerText.includes(dep.toLowerCase())) {
      triggers.push(dep);
    }
  }

  return triggers;
}

const STALENESS_THRESHOLD = 0.35;
const STALENESS_CAP = 0.7;

/**
 * Compute semantic staleness confidence for candidate stale records.
 * Returns a Map<recordId, confidence> where confidence is 0-1.
 * Records below STALENESS_THRESHOLD are not included (not stale).
 */
export function computeSemanticStaleness(
  staleCandidates: Map<string, string[]>,
  recordEmbeddings: Map<string, Float32Array>,
  diffEmbeddings: Map<string, Float32Array>,
): Map<string, number> {
  const result = new Map<string, number>();

  for (const [recordId, changedPaths] of staleCandidates) {
    const recordEmb = recordEmbeddings.get(recordId);
    if (!recordEmb) continue;

    // Find the maximum similarity across all changed paths for this record
    let maxSimilarity = 0;
    for (const path of changedPaths) {
      const diffEmb = diffEmbeddings.get(path);
      if (!diffEmb) continue;
      const sim = dotProduct(recordEmb, diffEmb);
      if (sim > maxSimilarity) maxSimilarity = sim;
    }

    if (maxSimilarity >= STALENESS_THRESHOLD) {
      // Normalize to 0-1 confidence: 0.35 → 0, 0.7+ → 1.0
      const confidence = Math.min(
        (maxSimilarity - STALENESS_THRESHOLD) / (STALENESS_CAP - STALENESS_THRESHOLD),
        1.0,
      );
      result.set(recordId, confidence);
    }
  }

  return result;
}

/**
 * Compute staleness for a set of record IDs. Used by recall to add [stale] markers.
 * Returns a Map of record IDs to staleness confidence (0-1).
 */
export async function computeStaleRecordIds(
  db: Database,
  projectRoot: string,
): Promise<Map<string, number>> {
  const staleMap = new Map<string, number>();

  const lastSnapshot = getLastSnapshot(db);
  if (!lastSnapshot) return staleMap;

  const currentState = scanProject(projectRoot);
  const diff = diffSnapshots(lastSnapshot, currentState);

  const changedPaths = getChangedPaths(diff);
  const changedDeps = getChangedDeps(diff);

  if (changedPaths.length === 0 && changedDeps.length === 0) return staleMap;

  // Collect candidate stale records and their embeddings
  const staleCandidates = new Map<string, string[]>();
  const recordEmbeddings = new Map<string, Float32Array>();

  const decisions = db.all(
    `SELECT id, content_text, embedding FROM record
     WHERE type = 'decision' AND embedding IS NOT NULL
       AND retracted_at IS NULL AND archived_at IS NULL`,
  ) as unknown as Array<{ id: string; content_text: string; embedding: Uint8Array }>;

  for (const record of decisions) {
    const triggers = findPathMentions(record.content_text, changedPaths);
    if (triggers.length > 0) {
      staleCandidates.set(record.id, triggers);
      recordEmbeddings.set(record.id, deserializeEmbedding(record.embedding));
    }
  }

  // Framework fixes — semantic staleness for file-path triggers, binary for dep matches
  if (changedDeps.length > 0 || changedPaths.length > 0) {
    const fixes = db.all(
      `SELECT id, content_text, embedding FROM record
       WHERE type = 'framework_fix' AND retracted_at IS NULL AND archived_at IS NULL
         AND embedding IS NOT NULL`,
    ) as unknown as Array<{ id: string; content_text: string; embedding: Uint8Array }>;

    for (const record of fixes) {
      // Check dependency mentions (high confidence — precise match)
      if (changedDeps.length > 0 && findDepMentions(record.content_text, changedDeps).length > 0) {
        staleMap.set(record.id, 1.0);
        continue; // Already marked with max confidence
      }

      // Check file path mentions (use semantic confidence like decisions)
      const triggers = findPathMentions(record.content_text, changedPaths);
      if (triggers.length > 0) {
        staleCandidates.set(record.id, triggers);
        recordEmbeddings.set(record.id, deserializeEmbedding(record.embedding));
      }
    }
  }

  // Generate diff embeddings for changed files
  if (staleCandidates.size > 0) {
    const { generateEmbedding } = await import('../vector/embeddings.js');
    const diffEmbeddings = new Map<string, Float32Array>();

    for (const path of changedPaths) {
      try {
        const filePath = join(projectRoot, path);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8').slice(0, 2000); // Cap at 2K chars
          const embedding = await generateEmbedding(content);
          diffEmbeddings.set(path, embedding);
        }
      } catch {
        // Skip files that can't be read
      }
    }

    const semanticStale = computeSemanticStaleness(staleCandidates, recordEmbeddings, diffEmbeddings);
    for (const [id, confidence] of semanticStale) {
      staleMap.set(id, confidence);
    }
  }

  return staleMap;
}

/**
 * Detect AST-anchored staleness for records that have target_file + target_symbol + ast_hash.
 * Recomputes the structural hash for the symbol and compares against the stored hash.
 * Returns stale record descriptions for the compiled context.
 */
async function detectAstStaleness(db: Database, projectRoot?: string): Promise<string[]> {
  if (!projectRoot) return [];

  const records = db.all(
    `SELECT id, content_text, created_at, target_file, target_symbol, ast_hash
     FROM record
     WHERE ast_hash IS NOT NULL AND target_file IS NOT NULL AND target_symbol IS NOT NULL
       AND retracted_at IS NULL AND archived_at IS NULL`,
  ) as unknown as Array<{
    id: string;
    content_text: string;
    created_at: string;
    target_file: string;
    target_symbol: string;
    ast_hash: string;
  }>;

  if (records.length === 0) return [];

  const stale: string[] = [];

  for (const record of records) {
    try {
      const currentHash = await computeAstHashForRecord(
        record.target_file,
        record.target_symbol,
        projectRoot,
      );

      if (currentHash === null) {
        // File or symbol no longer exists
        const shortId = record.id.slice(0, 8);
        const date = record.created_at.slice(0, 10);
        const firstLine = record.content_text.split('\n')[0].slice(0, 100);
        stale.push(
          `[${shortId}] (${date}) ${firstLine} — AST: symbol "${record.target_symbol}" not found in ${record.target_file}`,
        );
      } else if (currentHash !== record.ast_hash) {
        // Structure has changed
        const shortId = record.id.slice(0, 8);
        const date = record.created_at.slice(0, 10);
        const firstLine = record.content_text.split('\n')[0].slice(0, 100);
        stale.push(
          `[${shortId}] (${date}) ${firstLine} — AST changed: ${record.target_symbol} in ${record.target_file}`,
        );
      }
      // If hash matches, the record is still valid — no staleness flag
    } catch {
      // AST parsing failed — skip this record (don't flag as stale due to parse failure)
    }
  }

  return stale;
}

/**
 * Compute AST-anchored stale record IDs. Used by relevance search.
 * Returns a Set of record IDs whose AST hash no longer matches.
 */
export async function computeAstStaleRecordIds(db: Database, projectRoot: string): Promise<Set<string>> {
  const staleIds = new Set<string>();

  const records = db.all(
    `SELECT id, target_file, target_symbol, ast_hash
     FROM record
     WHERE ast_hash IS NOT NULL AND target_file IS NOT NULL AND target_symbol IS NOT NULL
       AND retracted_at IS NULL AND archived_at IS NULL`,
  ) as unknown as Array<{
    id: string;
    target_file: string;
    target_symbol: string;
    ast_hash: string;
  }>;

  for (const record of records) {
    try {
      const currentHash = await computeAstHashForRecord(
        record.target_file,
        record.target_symbol,
        projectRoot,
      );

      if (currentHash === null || currentHash !== record.ast_hash) {
        staleIds.add(record.id);
      }
    } catch {
      // Parse failure — don't flag as stale
    }
  }

  return staleIds;
}

export function formatContextAsMarkdown(ctx: CompiledContext): string {
  const parts: string[] = [];

  parts.push(`Compiled context: ~${ctx.token_estimate} tokens\n`);

  if (ctx.warnings.length > 0) {
    parts.push(ctx.warnings.join('\n'));
    parts.push('');
  }

  // 1. Last session summary
  parts.push('## Last Session Summary\n');
  if (ctx.sections.last_session) {
    parts.push(ctx.sections.last_session);
  } else {
    parts.push('No previous session log available.');
  }
  parts.push('');

  // 2. Open TODOs
  parts.push('## Open TODOs\n');
  if (ctx.sections.open_todos.length > 0) {
    for (const todo of ctx.sections.open_todos) {
      parts.push(todo);
    }
  } else {
    parts.push('No open TODOs.');
  }
  parts.push('');

  // 3. Epic context
  if (ctx.sections.epic_context) {
    parts.push('## Epic Context\n');
    parts.push(ctx.sections.epic_context);
    parts.push('');
  }

  // 4. Framework fixes
  parts.push('## Framework Fixes\n');
  if (ctx.sections.framework_fixes.length > 0) {
    for (const fix of ctx.sections.framework_fixes) {
      parts.push(`- ${fix}`);
    }
  } else {
    parts.push('No framework fixes recorded.');
  }
  parts.push('');

  // 5. Spec constraints
  parts.push('## Spec Constraints\n');
  if (ctx.sections.spec_constraints.length > 0) {
    for (const spec of ctx.sections.spec_constraints) {
      parts.push(`- ${spec}`);
    }
  } else {
    parts.push('No applicable spec constraints.');
  }
  parts.push('');

  // 6. Persona tests
  parts.push('## Persona Tests\n');
  if (ctx.sections.persona_tests.length > 0) {
    for (const test of ctx.sections.persona_tests) {
      parts.push(`- ${test}`);
    }
  } else {
    parts.push('No active persona tests.');
  }
  parts.push('');

  // 7. Stale decisions
  if (ctx.sections.stale_decisions.length > 0) {
    parts.push('## \u26a0 Potentially Stale Decisions\n');
    for (const stale of ctx.sections.stale_decisions) {
      parts.push(`- ${stale}`);
    }
    parts.push('');
  }

  // 8. Sibling project context (workspace)
  if (ctx.sections.sibling_decisions && ctx.sections.sibling_decisions.length > 0) {
    parts.push('## Sibling Project Decisions\n');
    for (const d of ctx.sections.sibling_decisions) {
      parts.push(`- ${d}`);
    }
    parts.push('');
  }

  if (ctx.sections.sibling_fixes && ctx.sections.sibling_fixes.length > 0) {
    parts.push('## Sibling Project Fixes\n');
    for (const f of ctx.sections.sibling_fixes) {
      parts.push(`- ${f}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function daysSinceLastSession(closedAt: string | null): number {
  if (!closedAt) return 0;
  const ms = Date.now() - new Date(closedAt).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function contextToString(ctx: CompiledContext): string {
  const parts = [
    ctx.warnings.join(' '),
    ctx.sections.last_session ?? '',
    ctx.sections.open_todos.join(' '),
    ctx.sections.epic_context ?? '',
    ctx.sections.framework_fixes.join(' '),
    ctx.sections.spec_constraints.join(' '),
    ctx.sections.persona_tests.join(' '),
    ctx.sections.stale_decisions.join(' '),
  ];
  return parts.join(' ');
}

/**
 * memnant — MCP Server.
 *
 * Story 1.4: Exposes the ledger as MCP tools over stdio transport.
 * Story 2.3: Adds memnant_session_context tool.
 * Story 8.1: Auto-start session on mutating tool calls.
 * Story 8.2: Auto-close idle sessions.
 * Story 8.4: Stale session cleanup.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from '../version.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import type { Database } from '../ledger/database.js';
import { openDatabase } from '../ledger/database.js';
import { insertRecord } from '../ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../vector/embeddings.js';
import { searchRecords } from '../vector/search.js';
import { RECORD_TYPES } from '../types.js';
import type { ProjectConfig, RecordType } from '../types.js';
import { loadConfig, ConfigError, findProjectRoot } from '../config/load.js';
import { compileContext } from '../context/compile.js';
import { resolveChoreographyOptions } from '../context/choreography.js';
import { getActiveSession, closeSession, getSessionRecordCounts } from '../ledger/sessions.js';
import { checkCopy } from '../governor/copy-check.js';
import { checkDesign } from '../governor/design-check.js';
import {
  ensureActiveSession,
  startAutoCloseTimer,
  stopAutoCloseTimer,
  runAutoCloseChecks,
  type SessionManagerState,
} from './session-manager.js';
import { autoLinkRecord } from '../graph/relationships.js';
import { retractRecord } from '../ledger/admin.js';
import { computeAstHashForRecord } from '../ast/parser.js';
import { getLedgerStats } from '../ledger/stats.js';
import { relevanceSearch } from '../relevance/search.js';
import { trackAccess, updateAccessPatterns } from '../relevance/access.js';
import { synthesise } from '../synthesis/synthesise.js';
import { getContextForFile } from '../context/file-context.js';
import { generateProjectBrief, formatBriefAsMarkdown } from '../context/brief.js';
import { reindexRecords } from '../vector/reindex.js';
import { recordContextEvent, getContextEvents } from '../context/replay.js';
import { diffSpecSnapshots, getDiffableSpecs } from '../context/spec-diff.js';
import { evaluatePersonas, getPersonaQuestions, type PersonaEvalResult } from '../governor/persona-eval.js';
import { federatedSearch, resolveProjects } from '../registry/federated-search.js';
import { loadRegistry } from '../registry/registry.js';
import { parseCostFromRecord } from '../orchestrator/costs.js';

function log(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

/**
 * All MCP tool names exposed by the server. Used by detached mode to register
 * placeholders that return a helpful error until a project is initialised.
 */
const TOOL_NAMES = [
  'memnant_recall',
  'memnant_history',
  'memnant_log',
  'memnant_status',
  'memnant_session_context',
  'memnant_check_copy',
  'memnant_check_design',
  'memnant_synthesise',
  'memnant_context_for_file',
  'memnant_project_brief',
  'memnant_stats',
  'memnant_reindex',
  'memnant_harvest_memory',
  'memnant_replay',
  'memnant_spec_diff',
  'memnant_eval_persona',
  'memnant_federated_recall',
  'memnant_costs',
  'memnant_retract',
  'memnant_session_log',
  'memnant_session_close',
  'memnant_analytics',
] as const;

/**
 * Start the server in "detached" mode: the MCP handshake completes and all
 * tools are registered, but every tool call returns a helpful error because no
 * memnant project could be resolved. This keeps `memnant serve` alive when it
 * is spawned (via user-scope MCP registration) from a non-project directory,
 * instead of exiting and surfacing "Failed to connect" in the client.
 */
async function startDetachedServer(cwd: string): Promise<void> {
  const message =
    `No memnant project found in ${cwd} or any parent directory. Run \`memnant init\` first.`;

  const server = new McpServer({ name: 'memnant', version: VERSION });

  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      { description: 'memnant tool — no project resolved (run `memnant init` first)' },
      async () => ({
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      }),
    );
  }

  const cleanup = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`memnant MCP server started in detached mode (no project at ${cwd})`);
}

export async function startServer(): Promise<void> {
  const cwd = process.cwd();

  // Walk up to find the nearest memnant project
  const projectRoot = findProjectRoot(cwd);

  // No project in scope: idle gracefully rather than exiting, so a user-scope
  // MCP registration spawned from a non-project dir still connects.
  if (!projectRoot) {
    await startDetachedServer(cwd);
    return;
  }

  let config: ProjectConfig;
  try {
    config = loadConfig(projectRoot);
  } catch (err) {
    process.stderr.write((err instanceof ConfigError ? err.message : String(err)) + '\n');
    process.exit(1);
  }

  // Lightweight infrastructure check — warnings only, does not block startup
  try {
    const { preflightCheck } = await import('../doctor/preflight.js');
    preflightCheck(projectRoot, config);
  } catch {
    // Preflight is best-effort
  }

  const dbPath = join(projectRoot, config.memory.db_path);

  if (!existsSync(dbPath)) {
    await startDetachedServer(cwd);
    return;
  }

  const db = openDatabase(dbPath);

  // Session manager state for idle tracking
  const sessionState: SessionManagerState = {
    lastToolCallAt: Date.now(),
    intervalHandle: null,
  };

  // Start the auto-close timer
  startAutoCloseTimer(db, config, sessionState);

  /** Update lastToolCallAt and run auto-close checks before each tool call */
  async function onToolCall(): Promise<void> {
    sessionState.lastToolCallAt = Date.now();
    await runAutoCloseChecks(db, config, sessionState);
  }

  const server = new McpServer({
    name: 'memnant',
    version: VERSION,
  });

  // Tool: memnant_recall
  server.registerTool(
    'memnant_recall',
    {
      description: 'Search the memnant ledger with a natural language query. Returns ranked results by semantic similarity.',
      inputSchema: {
        query: z.string().describe('Natural language search query'),
        type: z.string().optional().describe('Filter by record type'),
        since: z.string().optional().describe('Filter to records after YYYY-MM-DD'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
        explain: z.boolean().optional().describe('Include per-signal relevance breakdown'),
        colony_only: z.boolean().optional().describe('Search only the colony (cross-project knowledge)'),
        builder: z.string().optional().describe('Filter by builder name'),
      },
    },
    async ({ query, type, since, limit, explain, colony_only, builder }) => {
      await onToolCall();
      log(`memnant_recall query="${query}"`);

      // Validate type
      if (type && !RECORD_TYPES.includes(type as RecordType)) {
        return {
          content: [{ type: 'text' as const, text: `Unknown record type '${type}'. Valid types: ${RECORD_TYPES.join(', ')}` }],
          isError: true,
        };
      }

      // Validate since
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid date format '${since}'. Expected YYYY-MM-DD (e.g. 2025-01-01).` }],
          isError: true,
        };
      }

      const queryEmbedding = await generateEmbedding(query);

      // Colony-only mode — skip project ledger
      if (colony_only) {
        try {
          const { openColonyDb } = await import('../colony/colony.js');
          const { searchColony } = await import('../colony/search.js');
          const colonyDb = openColonyDb();
          const colonyResults = searchColony(colonyDb, queryEmbedding, { limit: limit ?? 10, type: type as string | undefined });
          colonyDb.close();

          const colonyOutput = colonyResults.map(cr => ({
            id: `[colony] ${cr.id.slice(0, 8)}`,
            short_id: cr.id.slice(0, 8),
            type: cr.type,
            created_at: cr.created_at,
            content: cr.content_text,
            similarity: Math.round(cr.similarity * 1000) / 1000,
            tags: cr.tags,
            source: 'colony',
            source_project_id: cr.source_project_id,
          }));

          const responseText = JSON.stringify(colonyOutput, null, 2);
          return { content: [{ type: 'text' as const, text: responseText }] };
        } catch {
          return { content: [{ type: 'text' as const, text: '[]' }] };
        }
      }

      // Use relevance search (Epic 10) — includes staleness, decay, and frequency scoring
      const results = await relevanceSearch(db, queryEmbedding, {
        type: type as RecordType | undefined,
        since,
        limit: limit ?? 10,
        projectRoot: projectRoot,
        decayProfile: config.memory.decay_profile,
        weights: config.memory.relevance_weights,
        explain,
        builder,
      });

      // Track access (Story 10.2)
      if (results.length > 0) {
        const accessedIds = results.map((r) => r.id);
        trackAccess(db, accessedIds, 'recall');
        updateAccessPatterns(db, accessedIds);
      }

      const jsonOutput = results.map((r) => ({
        id: r.id,
        short_id: r.id.slice(0, 8),
        type: r.type,
        created_at: r.created_at,
        content: r.content_text,
        similarity: Math.round(r.similarity * 1000) / 1000,
        relevance: r.relevance,
        tags: r.tags,
        related_records: r.related_records,
        stale: r.is_stale,
        superseded: r.is_superseded,
        has_newer_version: r.has_newer_version ?? false,
        ...(explain && r.signals ? { signals: r.signals } : {}),
      }));

      // Merge colony results
      try {
        const { openColonyDb } = await import('../colony/colony.js');
        const { searchColony } = await import('../colony/search.js');
        const colonyDb = openColonyDb();
        const colonyResults = searchColony(colonyDb, queryEmbedding, { limit: 3, type: type as string | undefined });
        colonyDb.close();
        for (const cr of colonyResults) {
          jsonOutput.push({
            id: `[colony] ${cr.id.slice(0, 8)}`,
            short_id: cr.id.slice(0, 8),
            type: cr.type,
            created_at: cr.created_at,
            content: cr.content_text,
            similarity: Math.round(cr.similarity * 1000) / 1000,
            relevance: cr.similarity,
            tags: cr.tags,
            related_records: [],
            stale: false,
            superseded: false,
            has_newer_version: false,
          });
        }
      } catch {
        // Colony search is best-effort
      }

      const responseText = JSON.stringify(jsonOutput, null, 2);

      // Record context event
      const activeForReplay = getActiveSession(db, config.project.id);
      recordContextEvent(db, {
        sessionId: activeForReplay?.id ?? null,
        toolName: 'recall',
        query: JSON.stringify({ query, type, since, limit }),
        response: responseText,
        tokenEstimate: Math.ceil(responseText.length / 4),
      });

      return {
        content: [{ type: 'text' as const, text: responseText }],
      };
    },
  );

  // Tool: memnant_history
  server.registerTool(
    'memnant_history',
    {
      description: 'Show version history of a record. Returns all versions in chronological order.',
      inputSchema: {
        record_id: z.string().describe('Record ID (full or short prefix)'),
      },
    },
    async ({ record_id }) => {
      await onToolCall();
      log(`memnant_history record_id="${record_id}"`);

      let fullId = record_id;
      if (record_id.length < 36) {
        const match = db.get('SELECT id FROM record WHERE id LIKE ?', [`${record_id}%`]) as any;
        if (!match) {
          return { content: [{ type: 'text' as const, text: `No record found matching '${record_id}'.` }], isError: true };
        }
        fullId = match.id;
      }

      const { getVersionHistory } = await import('../graph/history.js');
      const history = getVersionHistory(db, fullId);

      if (history.length === 0) {
        return { content: [{ type: 'text' as const, text: `No record found for '${record_id}'.` }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(history, null, 2) }] };
    },
  );

  // Tool: memnant_log (auto-starts session)
  server.registerTool(
    'memnant_log',
    {
      description: 'Write a record to the memnant ledger. Auto-starts a session if none is active.',
      inputSchema: {
        type: z.string().describe('Record type (session_log, decision, framework_fix, spec_snapshot, codebase_snapshot, orchestrator_task)'),
        content: z.string().describe('Record content text'),
        tags: z.string().optional().describe('Comma-separated tags'),
        relates_to: z.string().optional().describe('Comma-separated related record IDs'),
        target_file: z.string().optional().describe('File path (relative to project root) this record is anchored to for AST-level staleness detection'),
        target_symbol: z.string().optional().describe('Symbol name (function, class, method) in the target file, or "global" for the entire file'),
        assumptions: z.string().optional().describe('JSON array of assumptions this decision depends on (e.g. \'["<100 users", "solo developer"]\')'),
        version_of: z.string().optional().describe('Record ID this is a new version of (creates version_of relationship)'),
      },
    },
    async ({ type, content, tags, relates_to, target_file, target_symbol, assumptions, version_of }) => {
      await onToolCall();
      log(`memnant_log type="${type}"`);

      // Validate type
      if (!RECORD_TYPES.includes(type as RecordType)) {
        return {
          content: [{ type: 'text' as const, text: `Unknown record type '${type}'. Valid types: ${RECORD_TYPES.join(', ')}` }],
          isError: true,
        };
      }

      if (!content.trim()) {
        return {
          content: [{ type: 'text' as const, text: 'Content cannot be empty.' }],
          isError: true,
        };
      }

      const parsedTags = tags ? tags.split(',').map((t) => t.trim()) : [];
      const relatedRecords = relates_to ? relates_to.split(',').map((id) => id.trim()) : [];

      let parsedAssumptions: string[] | null = null;
      if (assumptions) {
        try {
          const arr = JSON.parse(assumptions);
          if (Array.isArray(arr)) parsedAssumptions = arr;
        } catch {
          // Invalid JSON — ignore
        }
      }

      const embedding = await generateEmbedding(content);
      const embeddingBuffer = serializeEmbedding(embedding);

      // Compute AST hash if target_file and target_symbol are provided
      let astHash: string | null = null;
      if (target_file && target_symbol) {
        try {
          astHash = await computeAstHashForRecord(target_file, target_symbol, projectRoot);
        } catch (err) {
          log(`AST hash computation failed for ${target_file}:${target_symbol}: ${err}`);
        }
      }

      // Auto-start session if none active (Story 8.1)
      const activeSession = ensureActiveSession(db, config.project.id);

      const record = insertRecord(db, {
        projectId: config.project.id,
        type: type as RecordType,
        contentText: content,
        tags: parsedTags,
        relatedRecords,
        embedding: embeddingBuffer,
        sourceSession: activeSession.id,
        targetFile: target_file ?? null,
        targetSymbol: target_symbol ?? null,
        astHash,
        assumptions: parsedAssumptions,
      });

      // Auto-link to related records (Epic 9)
      autoLinkRecord(db, record, config);

      // Create version_of relationship if specified
      if (version_of) {
        try {
          const { insertRelationship } = await import('../graph/relationships.js');
          insertRelationship(db, record.id, version_of, 'version_of', 1.0);
        } catch (err) {
          log(`version_of relationship failed: ${err}`);
        }
      }

      // Template validation (advisory)
      let missingFields: string[] = [];
      try {
        const { validateTemplate } = await import('../ledger/templates.js');
        const validation = validateTemplate(type, content, config);
        if (!validation.valid) {
          missingFields = validation.missing;
        }
      } catch {
        // Template validation is best-effort
      }

      // Auto-promote to colony if applicable
      try {
        const { shouldAutoPromote, promoteToColony } = await import('../colony/promote.js');
        const { openColonyDb } = await import('../colony/colony.js');
        if (shouldAutoPromote(type, parsedTags)) {
          const colonyDb = openColonyDb();
          await promoteToColony(colonyDb, record, config.project.id);
          colonyDb.close();
        }
      } catch {
        // Colony promotion is best-effort — never block record creation
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: record.id,
            type: record.type,
            created_at: record.created_at,
            ...(record.ast_hash ? { ast_anchored: true, target_file: record.target_file, target_symbol: record.target_symbol } : {}),
            ...(version_of ? { version_of } : {}),
            ...(missingFields.length > 0 ? { warning: `missing fields: ${missingFields.join(', ')}` } : {}),
          }),
        }],
      };
    },
  );

  // Tool: memnant_status (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_status',
    {
      description: 'Get memnant project status: project name, record count, session count, last session date.',
    },
    async () => {
      await onToolCall();
      log('memnant_status');

      const recordCount = (
        db.get('SELECT COUNT(*) as count FROM record WHERE retracted_at IS NULL AND archived_at IS NULL') as unknown as { count: number }
      ).count;

      const sessionCount = (
        db.get('SELECT COUNT(*) as count FROM session') as unknown as { count: number }
      ).count;

      const lastSessionRow = db.get(
        'SELECT started_at FROM session ORDER BY started_at DESC LIMIT 1',
      ) as unknown as { started_at: string } | undefined;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            project_name: config.project.name,
            record_count: recordCount,
            session_count: sessionCount,
            last_session_date: lastSessionRow?.started_at ?? null,
          }),
        }],
      };
    },
  );

  // Tool: memnant_session_context (auto-starts session)
  server.registerTool(
    'memnant_session_context',
    {
      description: 'Get compiled session context for a build session. Auto-starts a session if none is active.',
      inputSchema: {
        epic: z.string().optional().describe('Filter context by epic name'),
        include_specs: z.boolean().optional().describe('Include spec constraints (default true)'),
        include_personas: z.boolean().optional().describe('Include persona tests (default true)'),
      },
    },
    async ({ epic, include_specs, include_personas }) => {
      await onToolCall();
      log(`memnant_session_context epic="${epic ?? 'none'}"`);

      // Auto-harvest previous session's transcript
      try {
        const { harvest } = await import('../harvest/harvest.js');
        let harvestTierConfig = null;
        try {
          if (config.orchestrator?.tiers?.analysis) {
            harvestTierConfig = config.orchestrator.tiers.analysis;
          }
        } catch (e: any) { console.error('auto-harvest config failed:', e?.message); }
        const harvestResult = await harvest(db, projectRoot, config.project.id, { tierConfig: harvestTierConfig });
        if (harvestResult.recordsWritten > 0) {
          log(`harvest: ${harvestResult.recordsWritten} records extracted from transcript`);
        }
      } catch (err) {
        log(`harvest failed (non-blocking): ${err}`);
      }

      // Auto-import team shared records (best-effort)
      try {
        const { importSharedRecords } = await import('../team/sync.js');
        const sharedDir = join(projectRoot, '.memnant', 'shared');
        const importCount = await importSharedRecords(db, config.project.id, sharedDir);
        if (importCount > 0) {
          log(`team sync: imported ${importCount} new record${importCount > 1 ? 's' : ''} from .memnant/shared/`);
        }
      } catch (err) {
        log(`team sync import failed (non-blocking): ${err}`);
      }

      // Prune stale pheromone trails (best-effort)
      try {
        const { pruneStaleTrails } = await import('../relevance/trail-decay.js');
        pruneStaleTrails(db);
      } catch {
        // Trail pruning is best-effort
      }

      const docsPath = join(projectRoot, config.governor.docs_path);
      const ctx = await compileContext(db, {
        epic,
        docsPath,
        projectRoot: projectRoot,
        projectId: config.project.id,
        builder: config.project.builder,
        choreography: resolveChoreographyOptions(config),
      });

      // Auto-snapshot: staleness tracking is inert without a baseline.
      // Compile runs first so an aging snapshot still flags stale records
      // for this session before the baseline resets. Best-effort.
      try {
        const { ensureFreshSnapshot } = await import('../snapshot/take.js');
        const snap = await ensureFreshSnapshot(
          db,
          config.project.id,
          projectRoot,
          config.memory.max_codebase_snapshots,
          config.memory.snapshot_interval,
        );
        if (snap) {
          ctx.warnings.push(
            `Codebase snapshot ${snap.recordId.slice(0, 8)} taken automatically — staleness tracking active.`,
          );
          log(`auto-snapshot: ${snap.recordId.slice(0, 8)} created`);
        }
      } catch (err) {
        log(`auto-snapshot failed (non-blocking): ${err}`);
      }

      if (include_specs === false) {
        ctx.sections.spec_constraints = [];
      }
      if (include_personas === false) {
        ctx.sections.persona_tests = [];
      }

      // Merge colony framework fixes
      try {
        const { openColonyDb } = await import('../colony/colony.js');
        const { searchColony } = await import('../colony/search.js');
        const colonyDb = openColonyDb();
        const colonyQueryEmbed = await generateEmbedding(config.project.name);
        const colonyFixes = searchColony(colonyDb, colonyQueryEmbed, { limit: 3, type: 'framework_fix' });
        colonyDb.close();
        if (colonyFixes.length > 0) {
          ctx.sections.framework_fixes = ctx.sections.framework_fixes || [];
          ctx.sections.framework_fixes.push(
            '── Cross-Project Fixes ──',
            ...colonyFixes.map((f: any) => `[colony] ${f.content_text.slice(0, 200)}`)
          );
        }
      } catch {
        // Colony search is best-effort
      }

      // Inject living profile as preferences
      try {
        const { readProfile } = await import('../patterns/profile.js');
        const profile = readProfile();
        if (profile) {
          ctx.sections.preferences = profile.split('\n').filter(l => l.trim());
        }
      } catch {
        // Profile injection is best-effort
      }

      // Review pressure and active assumptions are now surfaced through the
      // choreography layer (process_guidance), computed in compileContext.
      // See src/context/choreography.ts — one coherent source, no duplication.

      // Stigmergy: surface cross-builder updates and contradictions for active files
      try {
        if (config.project.builder) {
          const activeSessionForStigmergy = getActiveSession(db, config.project.id);
          if (activeSessionForStigmergy) {
            const { findNewTeamRecordsForActiveFiles, formatTeamUpdates, findActiveContradictions } = await import('../team/stigmergy.js');
            const teamUpdates = findNewTeamRecordsForActiveFiles(db, activeSessionForStigmergy.id, config.project.builder);
            const contradictions = findActiveContradictions(db, activeSessionForStigmergy.id, config.project.builder);
            const updates: string[] = [];
            if (teamUpdates.length > 0) {
              updates.push(...formatTeamUpdates(teamUpdates));
            }
            if (contradictions.length > 0) {
              updates.push(
                ...contradictions.map(c =>
                  `[conflict \u00b7 ${c.other_builder}] Your "${c.my_content}" contradicts their "${c.other_content}"`,
                ),
              );
            }
            if (updates.length > 0) {
              ctx.sections.team_updates = updates;
            }
          }
        }
      } catch {
        // Stigmergy is best-effort
      }

      // Recruitment: surface high-confirmation colony patterns
      try {
        const { openColonyDb: openColonyForRecruitment } = await import('../colony/colony.js');
        const { findRecruitablePatterns } = await import('../colony/recruitment.js');
        const recruitColonyDb = openColonyForRecruitment();
        const recruitQueryEmbed = await generateEmbedding(config.project.name);
        const patterns = findRecruitablePatterns(recruitColonyDb, recruitQueryEmbed, 3);
        recruitColonyDb.close();
        if (patterns.length > 0) {
          ctx.sections.colony_patterns = [
            '── Colony Patterns (confirmed across projects) ──',
            ...patterns.map(p => `[${p.confirmation_count}x confirmed] ${p.content_text.slice(0, 200)}`),
          ];
        }
      } catch {
        // Colony recruitment is best-effort
      }

      // Death-spiral churn alerts are now surfaced through the choreography
      // layer (process_guidance, stage 'churn'), computed in compileContext.

      // Workspace: surface relevant sibling project records
      try {
        const { resolveWorkspace } = await import('../registry/workspace.js');
        const { fetchSiblingContext } = await import('../context/siblings.js');
        const workspace = resolveWorkspace(config.project.name, config);
        if (workspace) {
          const siblingRecords = await fetchSiblingContext(
            workspace.siblings,
            config.project.name,
            { epic: epic ?? undefined, limit: 5 },
          );
          if (siblingRecords.decisions.length > 0) {
            ctx.sections.sibling_decisions = [
              `\u2500\u2500 Sibling Decisions (workspace: ${workspace.name}) \u2500\u2500`,
              ...siblingRecords.decisions.map((r: any) =>
                `[${r.source_project}] ${r.content_text.split('\n')[0].slice(0, 150)}`
              ),
            ];
          }
          if (siblingRecords.fixes.length > 0) {
            ctx.sections.sibling_fixes = [
              `\u2500\u2500 Sibling Fixes (workspace: ${workspace.name}) \u2500\u2500`,
              ...siblingRecords.fixes.map((r: any) =>
                `[${r.source_project}] ${r.content_text.split('\n')[0].slice(0, 150)}`
              ),
            ];
          }
        }
      } catch {
        // Workspace context is best-effort
      }

      // Auto-start session if none active (Story 8.1)
      ensureActiveSession(db, config.project.id);

      // Render narrative briefing
      const { getLastClosedSession } = await import('../ledger/sessions.js');
      const { daysSinceLastSession } = await import('../context/compile.js');
      const { composeLlmBriefing } = await import('../context/narrative.js');

      const lastSession = getLastClosedSession(db);
      const days = daysSinceLastSession(lastSession?.closed_at ?? null);

      // Determine if LLM is available
      let tierConfig = null;
      try {
        if (config.orchestrator?.tiers?.analysis) {
          tierConfig = config.orchestrator.tiers.analysis;
        }
      } catch (e: any) { console.error('auto-export failed:', e?.message); }

      const briefing = await composeLlmBriefing(ctx, {
        daysSinceLastSession: days,
        colonyFixes: [],
        tierConfig,
      });

      // Add narrative briefing to response
      const response = {
        ...ctx,
        narrative: briefing.text,
        narrative_source: briefing.fallback ? 'template' : 'llm',
        // Structured choreography nudges for agents that act on typed signals.
        process: ctx.sections.process_guidance ?? [],
      };

      const responseText = JSON.stringify(response, null, 2);

      const activeForReplay = getActiveSession(db, config.project.id);
      recordContextEvent(db, {
        sessionId: activeForReplay?.id ?? null,
        toolName: 'session_context',
        query: JSON.stringify({ epic }),
        response: responseText,
        tokenEstimate: ctx.token_estimate,
      });

      return {
        content: [{
          type: 'text' as const,
          text: responseText,
        }],
      };
    },
  );

  // Tool: memnant_check_copy (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_check_copy',
    {
      description: 'Check text against the copy audit spec. Returns violations (banned, discouraged, tone).',
      inputSchema: {
        text: z.string().describe('Text to check against copy audit rules'),
      },
    },
    async ({ text }) => {
      await onToolCall();
      log('memnant_check_copy');
      const docsPath = join(projectRoot, config.governor.docs_path);
      const result = checkCopy(text, docsPath);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_check_design (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_check_design',
    {
      description: 'Check source code for banned components from the design system spec.',
      inputSchema: {
        code: z.string().describe('Source code to check'),
        filename: z.string().optional().describe('Filename for reporting'),
      },
    },
    async ({ code, filename }) => {
      await onToolCall();
      log('memnant_check_design');
      const docsPath = join(projectRoot, config.governor.docs_path);
      const result = checkDesign(code, filename ?? '<input>', docsPath);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_synthesise (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_synthesise',
    {
      description: 'Ask a question that spans multiple records. Returns a synthesised answer with citations. Supports cross-project synthesis via colony.',
      inputSchema: {
        question: z.string().describe('Question to synthesise an answer for'),
        include_colony: z.boolean().optional().describe('Include cross-project colony records (default false)'),
      },
    },
    async ({ question, include_colony }) => {
      await onToolCall();
      log(`memnant_synthesise question="${question.slice(0, 50)}" colony=${include_colony ?? false}`);

      try {
        let colonyDb = null;
        if (include_colony) {
          try {
            const { openColonyDb } = await import('../colony/colony.js');
            colonyDb = openColonyDb();
          } catch {
            // Colony not available
          }
        }

        const result = await synthesise(db, question, config, {
          projectRoot,
          includeColony: include_colony ?? false,
          colonyDb,
        });

        if (colonyDb) {
          try { colonyDb.close(); } catch (e: any) { console.error('colony db close failed:', e?.message); }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Synthesis failed: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: memnant_context_for_file (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_context_for_file',
    {
      description: 'Get records relevant to a specific file path. Finds decisions and framework fixes mentioning the file.',
      inputSchema: {
        file_path: z.string().describe('File path (relative to project root)'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
      },
    },
    async ({ file_path, limit }) => {
      await onToolCall();
      log(`memnant_context_for_file file="${file_path}"`);

      try {
        const result = await getContextForFile(db, file_path, {
          projectRoot: projectRoot,
          limit: limit ?? 10,
          decayProfile: config.memory.decay_profile,
        });

        const responseText = JSON.stringify(result, null, 2);

        const activeForReplay = getActiveSession(db, config.project.id);
        recordContextEvent(db, {
          sessionId: activeForReplay?.id ?? null,
          toolName: 'context_for_file',
          query: JSON.stringify({ file_path }),
          response: responseText,
          tokenEstimate: Math.ceil(responseText.length / 4),
        });

        return {
          content: [{
            type: 'text' as const,
            text: responseText,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `File context lookup failed: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: memnant_project_brief (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_project_brief',
    {
      description: 'Get a ~500-token dynamic project brief, or a full onboarding brief for new team members.',
      inputSchema: {
        onboarding: z.boolean().optional().describe('Generate onboarding brief for new team members'),
      },
    },
    async ({ onboarding }) => {
      await onToolCall();
      log(`memnant_project_brief onboarding=${!!onboarding}`);

      let text: string;

      if (onboarding) {
        const { compileOnboardingBrief, formatOnboardingBrief } = await import('../context/onboarding.js');
        const onboardingBrief = compileOnboardingBrief(db, config, projectRoot);
        text = formatOnboardingBrief(onboardingBrief);
      } else {
        const brief = generateProjectBrief(db, config, projectRoot);
        text = formatBriefAsMarkdown(brief);
      }

      const activeForReplay = getActiveSession(db, config.project.id);
      recordContextEvent(db, {
        sessionId: activeForReplay?.id ?? null,
        toolName: 'project_brief',
        response: text,
        tokenEstimate: Math.ceil(text.length / 4),
      });

      return {
        content: [{
          type: 'text' as const,
          text,
        }],
      };
    },
  );

  // Tool: memnant_stats (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_stats',
    {
      description: 'Get ledger statistics: record counts by type, retracted/archived counts, session info, graph metrics, health indicators.',
    },
    async () => {
      await onToolCall();
      log('memnant_stats');

      const stats = await getLedgerStats(db, projectRoot);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(stats, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_reindex (maintenance — no session auto-start)
  server.registerTool(
    'memnant_reindex',
    {
      description: 'Regenerate embeddings for records whose embedding model differs from the current model. Maintenance tool — no session required.',
      inputSchema: {
        stale_only: z.boolean().default(true).describe('Only reindex records with mismatched model (default: true)'),
        dry_run: z.boolean().default(false).describe('Report mismatch count without changing anything (default: false)'),
      },
    },
    async ({ stale_only, dry_run }) => {
      await onToolCall();
      log(`memnant_reindex stale_only=${stale_only} dry_run=${dry_run}`);

      const result = await reindexRecords(db, {
        staleOnly: stale_only,
        dryRun: dry_run,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_harvest_memory (maintenance — no session auto-start)
  server.registerTool(
    'memnant_harvest_memory',
    {
      description: 'Import institutional knowledge from Claude Code memory files into the memnant ledger. Deduplicates against existing records.',
      inputSchema: {
        dry_run: z.boolean().default(false).describe('Preview without writing records (default: false)'),
      },
    },
    async ({ dry_run }) => {
      await onToolCall();
      log(`memnant_harvest_memory dry_run=${dry_run}`);

      const { harvestMemory } = await import('../harvest/memory-harvest.js');
      const result = await harvestMemory({ dryRun: dry_run });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_replay (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_replay',
    {
      description: 'Replay the exact context served to the agent during a session. Shows all context events in chronological order.',
      inputSchema: {
        session_id: z.string().describe('Session ID (full or short prefix)'),
      },
    },
    async ({ session_id }) => {
      await onToolCall();
      log(`memnant_replay session="${session_id}"`);

      const sessionRow = db.get(
        'SELECT id FROM session WHERE id LIKE ?',
        [`${session_id}%`],
      ) as unknown as { id: string } | undefined;

      if (!sessionRow) {
        return {
          content: [{ type: 'text' as const, text: `No session found matching '${session_id}'.` }],
          isError: true,
        };
      }

      const events = getContextEvents(db, sessionRow.id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(events, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_spec_diff (read-only — does NOT auto-start)
  server.registerTool(
    'memnant_spec_diff',
    {
      description: 'Show what changed between spec document versions. Returns unified diff.',
      inputSchema: {
        filename: z.string().optional().describe('Spec filename to diff (omit for all specs with changes)'),
      },
    },
    async ({ filename }) => {
      await onToolCall();
      log(`memnant_spec_diff filename="${filename ?? 'all'}"`);

      if (filename) {
        const diff = diffSpecSnapshots(db, filename);
        if (!diff) {
          return {
            content: [{ type: 'text' as const, text: `No diff available for '${filename}'. Need at least 2 snapshots.` }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(diff, null, 2) }],
        };
      }

      const diffable = getDiffableSpecs(db);
      const diffs = diffable.map((f) => diffSpecSnapshots(db, f)).filter(Boolean);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(diffs, null, 2) }],
      };
    },
  );

  // Tool: memnant_eval_persona (requires API key — does NOT auto-start session)
  server.registerTool(
    'memnant_eval_persona',
    {
      description: 'Evaluate persona test questions using LLM analysis. Requires ANTHROPIC_API_KEY or OPENAI_API_KEY.',
      inputSchema: {
        session_id: z.string().optional().describe('Session ID to evaluate (default: active session)'),
        list: z.boolean().optional().describe('List persona test questions without running evaluation'),
      },
    },
    async ({ session_id, list }) => {
      await onToolCall();
      log(`memnant_eval_persona session="${session_id ?? 'active'}" list=${list ?? false}`);

      const docsPath = join(projectRoot, config.governor.docs_path);

      if (list) {
        const questions = getPersonaQuestions(docsPath);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(questions, null, 2),
          }],
        };
      }

      // Find session
      let sessionId: string;
      if (session_id) {
        const row = db.get(
          'SELECT id FROM session WHERE id LIKE ?',
          [`${session_id}%`],
        ) as unknown as { id: string } | undefined;
        if (!row) {
          return {
            content: [{ type: 'text' as const, text: `No session found matching '${session_id}'.` }],
            isError: true,
          };
        }
        sessionId = row.id;
      } else {
        const active = getActiveSession(db, config.project.id);
        if (!active) {
          return {
            content: [{ type: 'text' as const, text: 'No active session. Provide session_id to evaluate a specific session.' }],
            isError: true,
          };
        }
        sessionId = active.id;
      }

      try {
        const results = await evaluatePersonas(db, config, {
          sessionId,
          projectRoot: projectRoot,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(results, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Persona evaluation failed: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: memnant_federated_recall (read-only — does NOT auto-start session)
  server.registerTool(
    'memnant_federated_recall',
    {
      description: 'Search across multiple memnant projects. Requires projects to be registered via `memnant projects add`.',
      inputSchema: {
        query: z.string().describe('Natural language search query'),
        projects: z.array(z.string()).optional().describe('Project names to search (default: all registered)'),
        limit: z.number().optional().describe('Maximum results (default 10)'),
      },
    },
    async ({ query, projects: projectNames, limit }) => {
      await onToolCall();
      log(`memnant_federated_recall query="${query.slice(0, 50)}"`);

      try {
        const reg = loadRegistry();
        if (reg.projects.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No projects registered. Run `memnant projects add <path>` first.' }],
            isError: true,
          };
        }

        const targets = resolveProjects(projectNames, reg.projects);
        const results = await federatedSearch(query, targets, { limit: limit ?? 10 });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(results.map((r) => ({
              source_project: r.source_project,
              id: r.id,
              short_id: r.id.slice(0, 8),
              type: r.type,
              content: r.content_text,
              relevance: r.relevance,
              stale: r.is_stale,
            })), null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Federated search failed: ${err}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: memnant_costs (read-only — does NOT auto-start session)
  server.registerTool(
    'memnant_costs',
    {
      description: 'Query API spend by session, tier, or time period.',
      inputSchema: {
        session_id: z.string().optional().describe('Filter to a specific session'),
        since: z.string().optional().describe('Filter to records after YYYY-MM-DD'),
        group_by: z.enum(['tier', 'model', 'session']).optional().describe('Group costs by field'),
      },
    },
    async ({ session_id, since, group_by }) => {
      await onToolCall();
      log(`memnant_costs session="${session_id ?? 'all'}" since="${since ?? 'all'}"`);

      // Validate since format
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid date format '${since}'. Expected YYYY-MM-DD (e.g. 2025-01-01).` }],
          isError: true,
        };
      }

      let query = "SELECT content_text, source_session, created_at FROM record WHERE type IN ('orchestrator_task', 'synthesis_cache') AND retracted_at IS NULL";
      const params: string[] = [];

      if (session_id) {
        query += ' AND source_session LIKE ?';
        params.push(`${session_id}%`);
      }
      if (since) {
        query += ' AND created_at >= ?';
        params.push(since + 'T00:00:00.000Z');
      }

      query += ' ORDER BY created_at ASC';

      const rows = db.all(query, params) as unknown as Array<{ content_text: string; source_session: string | null; created_at: string }>;

      const costs: Array<{ tier: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number; session: string | null; date: string }> = [];
      for (const r of rows) {
        const meta = parseCostFromRecord(r.content_text);
        if (meta) costs.push({ ...meta, session: r.source_session, date: r.created_at });
      }

      const total = costs.reduce((sum, c) => sum + c.cost_usd, 0);

      if (group_by) {
        const groups = new Map<string, { count: number; tokens: number; cost: number }>();
        for (const c of costs) {
          const key = group_by === 'session' ? (c.session?.slice(0, 8) ?? 'none')
            : group_by === 'tier' ? c.tier
            : c.model;
          const existing = groups.get(key) ?? { count: 0, tokens: 0, cost: 0 };
          existing.count++;
          existing.tokens += c.input_tokens + c.output_tokens;
          existing.cost += c.cost_usd;
          groups.set(key, existing);
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ total_cost_usd: total, groups: Object.fromEntries(groups) }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ calls: costs.length, total_cost_usd: total, entries: costs }, null, 2),
        }],
      };
    },
  );

  // Tool: memnant_retract (mutating — auto-starts session)
  server.registerTool(
    'memnant_retract',
    {
      description: 'Retract a record that is wrong or no longer valid. Retracted records are excluded from recall, context, and export.',
      inputSchema: {
        record_id: z.string().describe('ID of the record to retract'),
        reason: z.string().describe('Why this record is being retracted'),
      },
    },
    async ({ record_id, reason }) => {
      await onToolCall();
      log(`memnant_retract record="${record_id.slice(0, 8)}"`);

      try {
        ensureActiveSession(db, config.project.id);
        retractRecord(db, record_id, reason);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ retracted: record_id, reason }),
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        };
      }
    },
  );

  // Tool: memnant_session_log (requires existing session — does NOT auto-start)
  server.registerTool(
    'memnant_session_log',
    {
      description: 'Log a progress summary without closing the session. Use when the human says "done" or signals a milestone but has not explicitly asked to close the session.',
      inputSchema: {
        summary: z.string().describe('Progress summary — what shipped, decisions made, gotchas, TODOs'),
      },
    },
    async ({ summary }) => {
      await onToolCall();
      log('memnant_session_log');

      const active = getActiveSession(db, config.project.id);
      if (!active) {
        return {
          content: [{ type: 'text' as const, text: 'No active session. Start one with `npx memnant` or `memnant session start`.' }],
          isError: true,
        };
      }

      if (!summary.trim()) {
        return {
          content: [{ type: 'text' as const, text: 'Summary cannot be empty. Describe what shipped, decisions made, and TODOs.' }],
          isError: true,
        };
      }

      const embedding = await generateEmbedding(summary);
      const embeddingBuffer = serializeEmbedding(embedding);

      const record = insertRecord(db, {
        projectId: config.project.id,
        type: 'session_log',
        contentText: summary,
        embedding: embeddingBuffer,
        sourceSession: active.id,
      });

      // Auto-link
      try {
        autoLinkRecord(db, record);
      } catch {
        // Best-effort
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'logged',
            session_id: active.id.slice(0, 8),
            log_record_id: record.id,
            session_still_active: true,
          }),
        }],
      };
    },
  );

  // Tool: memnant_session_close (requires existing session — does NOT auto-start)
  server.registerTool(
    'memnant_session_close',
    {
      description: 'Close the active build session with a summary log. The agent should call this at the end of every work session.',
      inputSchema: {
        summary: z.string().describe('Session log content — what shipped, decisions made, gotchas, TODOs'),
        stories_completed: z.string().optional().describe('Comma-separated story IDs completed in this session (e.g. "6.1, 6.2")'),
      },
    },
    async ({ summary, stories_completed }) => {
      await onToolCall();
      log('memnant_session_close');

      const active = getActiveSession(db, config.project.id);
      if (!active) {
        return {
          content: [{ type: 'text' as const, text: 'No active session to close. Start one with `npx memnant` or `memnant session start`.' }],
          isError: true,
        };
      }

      if (!summary.trim()) {
        return {
          content: [{ type: 'text' as const, text: 'Summary cannot be empty. Describe what shipped, decisions made, and TODOs.' }],
          isError: true,
        };
      }

      // Generate embedding and insert session_log record
      const embedding = await generateEmbedding(summary);
      const embeddingBuffer = serializeEmbedding(embedding);

      const record = insertRecord(db, {
        projectId: config.project.id,
        type: 'session_log',
        contentText: summary,
        embedding: embeddingBuffer,
        sourceSession: active.id,
      });

      // Store stories_completed if provided
      if (stories_completed) {
        const stories = stories_completed.split(',').map((s) => s.trim()).filter(Boolean);
        db.run(
          'UPDATE session SET stories_completed = ? WHERE id = ?',
          [JSON.stringify(stories), active.id],
        );
      }

      // Close the session
      closeSession(db, active.id, record.id);

      // Auto-export shareable records to .memnant/shared/ (best-effort)
      try {
        const { exportSharedRecords } = await import('../team/sync.js');
        const builderId = (config.project as any).builder ?? process.env.MEMNANT_BUILDER_ID ?? 'unknown';
        const sharedDir = join(projectRoot, '.memnant', 'shared');
        const exportCount = exportSharedRecords(db, active.id, config.project.id, sharedDir, builderId, config.project.name);
        if (exportCount > 0) {
          log(`team sync: exported ${exportCount} record${exportCount > 1 ? 's' : ''} to .memnant/shared/`);
        }
      } catch (err) {
        log(`team sync export failed (non-blocking): ${err}`);
      }

      // Auto-evaluate personas (best-effort — don't fail session close)
      let personaResults: PersonaEvalResult[] = [];
      try {
        personaResults = await evaluatePersonas(db, config, {
          sessionId: active.id,
          projectRoot: projectRoot,
        });
        for (const pr of personaResults) {
          log(`persona eval: ${pr.persona} — ${pr.result} (${pr.confidence})`);
        }
      } catch {
        // Persona eval is best-effort
      }

      // Detect patterns and rebuild profile (best-effort)
      try {
        const { openColonyDb } = await import('../colony/colony.js');
        const { detectPatterns } = await import('../patterns/detect.js');
        const { generateProfile, writeProfile } = await import('../patterns/profile.js');

        const colonyDb = openColonyDb();
        let patternTierConfig = null;
        try {
          if (config.orchestrator?.tiers?.analysis) {
            patternTierConfig = config.orchestrator.tiers.analysis;
          }
        } catch (e: any) { console.error('auto-import failed:', e?.message); }

        const patternResult = await detectPatterns(db, colonyDb, { tierConfig: patternTierConfig });

        if (patternResult.patternsCreated > 0 || patternResult.patternsUpdated > 0) {
          log(`patterns: ${patternResult.patternsCreated} created, ${patternResult.patternsUpdated} updated`);
          const profileContent = generateProfile(colonyDb);
          writeProfile(profileContent);
        }

        colonyDb.close();
      } catch (err) {
        log(`pattern detection failed (non-blocking): ${err}`);
      }

      // Compute duration
      const startMs = new Date(active.started_at).getTime();
      const durationMs = Date.now() - startMs;
      const minutes = Math.floor(durationMs / 60000);
      const hours = Math.floor(minutes / 60);
      const durationStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

      const counts = getSessionRecordCounts(db, active.id);
      const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            session_id: active.id.slice(0, 8),
            duration: durationStr,
            records_created: totalRecords,
            log_record_id: record.id,
            ...(personaResults.length > 0 ? {
              persona_eval: personaResults.map((pr) => ({
                persona: pr.persona,
                result: pr.result,
                confidence: pr.confidence,
              })),
            } : {}),
          }),
        }],
      };
    },
  );

  // Tool: memnant_analytics
  server.registerTool(
    'memnant_analytics',
    {
      description: 'Get ledger health analytics: decision velocity, knowledge areas, coverage gaps, assumption load.',
      inputSchema: {},
    },
    async () => {
      await onToolCall();
      log('memnant_analytics');

      const { computeAnalytics } = await import('../analytics/analytics.js');
      const report = await computeAnalytics(db, config.project.id);

      return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
    },
  );

  // Signal handling
  const cleanup = () => {
    stopAutoCloseTimer(sessionState);
    db.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`memnant MCP server started on stdio (project: ${projectRoot})`);
}

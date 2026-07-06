/**
 * memnant recall — Semantic search over the ledger.
 *
 * Story 1.3: Finds relevant records using vector similarity against a
 * natural language query. Supports type, date, and limit filters.
 * Text output is one record per line; --json for structured output.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerRecallCommand(program: Command): void {
  program
    .command('recall')
    .description('Search the ledger with a natural language query')
    .argument('<query>', 'Natural language search query')
    .option('--type <type>', 'Filter by record type')
    .option('--since <date>', 'Filter to records after YYYY-MM-DD')
    .option('--limit <n>', 'Maximum results (default 10)', '10')
    .option('--full', 'Show complete content instead of truncated')
    .option('--json', 'Output as JSON array')
    .option('--include-retracted', 'Include retracted records in results')
    .option('--include-archived', 'Include archived records in results')
    .option('--explain', 'Show per-signal relevance breakdown')
    .option('--builder <name>', 'Filter by builder name')
    .option('--mine', 'Filter to current builder (from config)')
    .action(
      async (
        query: string,
        opts: { type?: string; since?: string; limit: string; full?: boolean; json?: boolean; includeRetracted?: boolean; includeArchived?: boolean; explain?: boolean; builder?: string; mine?: boolean },
      ) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { generateEmbedding } = await import('../vector/embeddings.js');
      const { relevanceSearch } = await import('../relevance/search.js');
      const { RECORD_TYPES } = await import('../types.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

        // Validate --type
        if (opts.type && !RECORD_TYPES.includes(opts.type as (typeof RECORD_TYPES)[number])) {
          console.error(
            `Unknown record type '${opts.type}'. Valid types: ${RECORD_TYPES.join(', ')}`,
          );
          process.exit(1);
        }

        // Validate --since
        if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
          console.error(
            `Invalid date format '${opts.since}'. Expected YYYY-MM-DD (e.g. 2025-01-01).`,
          );
          process.exit(1);
        }

        // Validate --limit
        const limit = parseInt(opts.limit, 10);
        if (isNaN(limit) || limit < 1) {
          console.error(`Invalid limit '${opts.limit}'. Must be a positive integer.`);
          process.exit(1);
        }

        // Load project config
        const cwd = process.cwd();
        const projectRoot = findProjectRoot(cwd);
        if (!projectRoot) {
          console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
          process.exit(1);
        }

        let config;
        try {
          config = loadConfig(projectRoot);
        } catch (err) {
          console.error(err instanceof ConfigError ? err.message : String(err));
          process.exit(1);
        }

        const dbPath = join(projectRoot, config.memory.db_path);

        if (!existsSync(dbPath)) {
          console.error(
            `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
          );
          process.exit(1);
        }

        const db = openDatabase(dbPath);

        // Resolve builder filter
        let builderFilter = opts.builder;
        if (opts.mine && !builderFilter) {
          builderFilter = (config as any).project?.builder;
          if (!builderFilter) {
            console.error('No builder configured. Run `memnant init --team` or set project.builder in memnant.yaml.');
            process.exit(1);
          }
        }

        // Generate query embedding and search
        let results: Awaited<ReturnType<typeof relevanceSearch>>;
        try {
          const queryEmbedding = await generateEmbedding(query);
          results = await relevanceSearch(db, queryEmbedding, {
            type: opts.type as (typeof RECORD_TYPES)[number] | undefined,
            since: opts.since,
            limit,
            projectRoot,
            explain: opts.explain,
            includeRetracted: opts.includeRetracted,
            includeArchived: opts.includeArchived,
            builder: builderFilter,
          });
        } finally {
          db.close();
        }

        if (results.length === 0) {
          console.log('No relevant records found.');
          return;
        }

        if (opts.json) {
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
            ...(opts.explain && r.signals ? { signals: r.signals } : {}),
          }));
          console.log(JSON.stringify(jsonOutput, null, 2));
          return;
        }

        // Text output: one record per line
        for (const r of results) {
          const shortId = r.id.slice(0, 8);
          const date = r.created_at.slice(0, 10);
          const staleMarker = r.is_stale ? ' [stale]' : '';
          const supersededMarker = r.is_superseded ? ' [superseded]' : '';
          const versionMarker = r.has_newer_version ? ' [v2 available]' : '';
          const collapsed = r.content_text.replace(/\n/g, ' ');
          const content =
            !opts.full && collapsed.length > 200 ? collapsed.slice(0, 200) + '...' : collapsed;

          console.log(`${shortId}  ${r.type}  ${date}  ${r.relevance.toFixed(3)}${staleMarker}${supersededMarker}${versionMarker}  ${content}`);

          if (opts.explain && r.signals) {
            const s = r.signals;
            console.log(`   relevance: ${r.relevance.toFixed(3)}`);
            console.log(`   \u251C\u2500 similarity:  ${s.similarity.raw.toFixed(3)} \u00D7 ${s.similarity.weight.toFixed(2)} = ${s.similarity.weighted.toFixed(3)}`);
            console.log(`   \u251C\u2500 recency:     ${s.recency.raw.toFixed(3)} \u00D7 ${s.recency.weight.toFixed(2)} = ${s.recency.weighted.toFixed(3)}`);
            const confStr = s.freshness.staleness_confidence !== undefined
              ? ` (stale: ${s.freshness.staleness_confidence.toFixed(2)})`
              : '';
            console.log(`   \u251C\u2500 freshness:   ${s.freshness.raw.toFixed(3)} \u00D7 ${s.freshness.weight.toFixed(2)} = ${s.freshness.weighted.toFixed(3)}${confStr}`);
            if (s.builder_diversity) {
              console.log(`   ├─ diversity:   ${s.builder_diversity.confirmations} builder(s) +${s.builder_diversity.boost.toFixed(3)}`);
            }
            if (s.co_occurrence) {
              console.log(`   ├─ co_occurrence: +${s.co_occurrence.boost.toFixed(3)} trail boost`);
            }
            console.log(`   \u2514\u2500 frequency:   ${s.frequency.raw.toFixed(3)} \u00D7 ${s.frequency.weight.toFixed(2)} = ${s.frequency.weighted.toFixed(3)}`);
          }
        }
      },
    );
}

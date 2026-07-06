/**
 * memnant costs — Query API spend by session, tier, or time period.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import type { CostMetadata } from '../orchestrator/costs.js';

interface CostRow {
  content_text: string;
  source_session: string | null;
  created_at: string;
}

export function registerCostsCommand(program: Command): void {
  program
    .command('costs')
    .description('Query API spend by session, tier, or time period')
    .option('--session <id>', 'Filter to a specific session')
    .option('--since <date>', 'Filter to records after YYYY-MM-DD')
    .option('--group-by <field>', 'Group by: tier, model, session')
    .option('--json', 'Output as JSON')
    .action(async (opts: { session?: string; since?: string; groupBy?: string; json?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { parseCostFromRecord } = await import('../orchestrator/costs.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

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

      // Validate --since
      if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
        console.error(`Invalid date format '${opts.since}'. Expected YYYY-MM-DD (e.g. 2025-01-01).`);
        process.exit(1);
      }

      // Validate --group-by
      if (opts.groupBy && !['tier', 'model', 'session'].includes(opts.groupBy)) {
        console.error(`Invalid group-by field '${opts.groupBy}'. Valid values: tier, model, session`);
        process.exit(1);
      }

      const dbPath = join(projectRoot, config.memory.db_path);

      if (!existsSync(dbPath)) {
        console.error(`Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`);
        process.exit(1);
      }

      const db = openDatabase(dbPath);
      let rows: CostRow[];
      try {
        let query = "SELECT content_text, source_session, created_at FROM record WHERE type IN ('orchestrator_task', 'synthesis_cache') AND retracted_at IS NULL";
        const params: string[] = [];

        if (opts.session) {
          query += ' AND source_session LIKE ?';
          params.push(`${opts.session}%`);
        }

        if (opts.since) {
          query += ' AND created_at >= ?';
          params.push(opts.since + 'T00:00:00.000Z');
        }

        query += ' ORDER BY created_at ASC';

        rows = db.all(query, params) as unknown as CostRow[];
      } finally {
        db.close();
      }

      // Extract cost metadata from records
      const costs: Array<CostMetadata & { session: string | null; date: string }> = [];
      for (const row of rows) {
        const meta = parseCostFromRecord(row.content_text);
        if (meta) {
          costs.push({ ...meta, session: row.source_session, date: row.created_at.slice(0, 10) });
        }
      }

      if (costs.length === 0) {
        console.log('No cost data found. API calls log cost metadata automatically.');
        return;
      }

      if (opts.groupBy) {
        const groups = new Map<string, { count: number; tokens: number; cost: number }>();
        for (const c of costs) {
          const key = opts.groupBy === 'session' ? (c.session?.slice(0, 8) ?? 'none')
            : opts.groupBy === 'tier' ? c.tier
            : c.model;
          const existing = groups.get(key) ?? { count: 0, tokens: 0, cost: 0 };
          existing.count++;
          existing.tokens += c.input_tokens + c.output_tokens;
          existing.cost += c.cost_usd;
          groups.set(key, existing);
        }

        if (opts.json) {
          console.log(JSON.stringify(Object.fromEntries(groups), null, 2));
          return;
        }

        for (const [key, data] of groups) {
          console.log(`${key}  ${data.count} calls  ${data.tokens} tokens  $${data.cost.toFixed(4)}`);
        }
      } else {
        const total = costs.reduce((sum, c) => sum + c.cost_usd, 0);
        const totalTokens = costs.reduce((sum, c) => sum + c.input_tokens + c.output_tokens, 0);

        if (opts.json) {
          console.log(JSON.stringify({ calls: costs.length, tokens: totalTokens, cost_usd: total, entries: costs }, null, 2));
          return;
        }

        console.log(`${costs.length} API calls  ${totalTokens} tokens  $${total.toFixed(4)}`);
      }
    });
}

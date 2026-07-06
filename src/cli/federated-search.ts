/**
 * memnant search — Federated search across multiple project ledgers.
 */

import { Command } from 'commander';

export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search across multiple memnant projects')
    .argument('<query>', 'Natural language search query')
    .option('--projects <names...>', 'Project names to search (default: all registered)')
    .option('--limit <n>', 'Maximum results', '10')
    .option('--type <type>', 'Filter by record type')
    .option('--since <date>', 'Filter to records after YYYY-MM-DD')
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: { projects?: string[]; limit: string; type?: string; since?: string; json?: boolean }) => {
      const { loadRegistry } = await import('../registry/registry.js');
      const { federatedSearch, resolveProjects } = await import('../registry/federated-search.js');

      // Validate --since
      if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
        console.error(`Invalid date format '${opts.since}'. Expected YYYY-MM-DD (e.g. 2025-01-01).`);
        process.exit(1);
      }

      // Validate --limit
      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1) {
        console.error(`Invalid limit '${opts.limit}'. Must be a positive integer.`);
        process.exit(1);
      }

      const reg = loadRegistry();
      if (reg.projects.length === 0) {
        console.error('No projects registered. Run `memnant init` in a project or `memnant projects add <path>`.');
        process.exit(1);
      }

      const targets = resolveProjects(opts.projects, reg.projects);
      if (targets.length === 0) {
        console.error(`No matching projects found. Registered: ${reg.projects.map((p) => p.name).join(', ')}`);
        process.exit(1);
      }

      const results = await federatedSearch(query, targets, {
        limit,
        type: opts.type,
        since: opts.since,
      });

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log('No results found.');
        return;
      }

      for (const r of results) {
        const staleTag = r.is_stale ? ' [stale]' : '';
        console.log(`[${r.source_project}] ${r.id.slice(0, 8)} (${r.type})${staleTag} — ${r.content_text.split('\n')[0].slice(0, 100)}`);
      }
    });
}

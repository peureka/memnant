/**
 * memnant replay — Show context events for a session.
 *
 * Displays the exact context that was served to the agent
 * during a given session, in chronological order.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerReplayCommand(program: Command): void {
  program
    .command('replay <session-id>')
    .description('Show context events for a session — what the agent actually saw')
    .option('--full', 'Print complete response text')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { full?: boolean; json?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { getContextEvents } = await import('../context/replay.js');
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

      const dbPath = join(projectRoot, config.memory.db_path);

      if (!existsSync(dbPath)) {
        console.error(`Ledger database not found at ${config.memory.db_path}.`);
        process.exit(1);
      }

      const db = openDatabase(dbPath);

      let sessionRow: { id: string } | undefined;
      let events: ReturnType<typeof getContextEvents> = [];
      try {
        // Support short IDs — find full session ID
        sessionRow = db.get(
          'SELECT id FROM session WHERE id LIKE ?',
          [`${sessionId}%`],
        ) as unknown as { id: string } | undefined;

        if (!sessionRow) {
          console.error(`No session found matching '${sessionId}'.`);
          process.exit(1);
        }

        events = getContextEvents(db, sessionRow.id);
      } finally {
        db.close();
      }

      if (events.length === 0) {
        console.log(`No context events recorded for session ${sessionRow.id.slice(0, 8)}.`);
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }

      // Text output
      console.log(`Context events for session ${sessionRow.id.slice(0, 8)} (${events.length} events):\n`);

      for (const event of events) {
        const time = event.created_at.slice(11, 19);
        const tokens = event.token_estimate ? `~${event.token_estimate} tokens` : '';
        const query = event.query ? ` query=${event.query}` : '';

        console.log(`  ${time}  ${event.tool_name}${query}  ${tokens}`);

        if (opts.full) {
          console.log(`  ${'-'.repeat(60)}`);
          console.log(`  ${event.response}`);
          console.log('');
        }
      }
    });
}

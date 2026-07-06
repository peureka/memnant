/**
 * memnant default action — State detection and routing.
 *
 * Story 6.1: When `memnant` is invoked with no subcommand, detect state and route:
 * 1. No memnant.yaml → run interactive init
 * 2. memnant.yaml exists, no active session → start session + print context
 * 3. Active session exists → show session status
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { findProjectRoot } from '../config/load.js';

export async function defaultAction(): Promise<void> {
  const cwd = process.cwd();
  const projectRoot = findProjectRoot(cwd);

  // State 1: Not initialised → run init
  if (!projectRoot) {
    // Import init module and invoke directly
    const initModule = await import('./init.js');
    // Trigger init via registered command by re-parsing with 'init' arg
    const { Command } = await import('commander');
    const tempProgram = new Command();
    tempProgram.exitOverride(); // Don't call process.exit
    initModule.registerInitCommand(tempProgram);
    await tempProgram.parseAsync(['init'], { from: 'user' });
    return;
  }

  const { loadConfig, ConfigError } = await import('../config/load.js');

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

  const { openDatabase } = await import('../ledger/database.js');
  const { createSession, getActiveSession, getSessionRecordCounts } = await import('../ledger/sessions.js');

  const db = openDatabase(dbPath);

  try {
    const active = getActiveSession(db, config.project.id);

    if (active) {
      // State 3: Active session → show status
      const duration = formatDuration(new Date(active.started_at), new Date());
      const counts = getSessionRecordCounts(db, active.id);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);

      console.log(`Session: ${active.id.slice(0, 8)}`);
      console.log(`Started: ${active.started_at.slice(0, 19).replace('T', ' ')}`);
      console.log(`Duration: ${duration}`);
      if (active.epic) {
        console.log(`Epic: ${active.epic}`);
      }
      console.log(`Records: ${total}`);
      if (total > 0) {
        for (const [type, count] of Object.entries(counts)) {
          console.log(`  ${type}: ${count}`);
        }
      }
    } else {
      // State 2: No active session → start session + print context
      const { compileContext, formatContextAsMarkdown } = await import('../context/compile.js');
      const { getLastSnapshotDate } = await import('../snapshot/scanner.js');

      const docsPath = join(projectRoot, config.governor.docs_path);
      const ctx = await compileContext(db, { docsPath, projectRoot, builder: config.project.builder });

      // Snapshot age reminder
      if (config.memory.snapshot_interval === 'monthly') {
        const lastDate = getLastSnapshotDate(db);
        if (lastDate) {
          const daysSince = Math.floor(
            (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysSince > 30) {
            ctx.warnings.push(
              `Last codebase snapshot is ${daysSince} days old. Run \`memnant snapshot\` to update staleness tracking.`,
            );
          }
        }
      }

      const session = createSession(db, config.project.id);
      process.stderr.write(`Session ${session.id.slice(0, 8)} started.\n`);
      console.log(formatContextAsMarkdown(ctx));
    }
  } finally {
    db.close();
  }
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

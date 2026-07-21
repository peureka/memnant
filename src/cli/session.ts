/**
 * memnant session — Session lifecycle commands.
 *
 * Story 2.1: session start with context compilation.
 * Story 2.2: session close with log capture.
 * Story 2.4: session status.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ProjectConfig } from '../types.js';

async function loadProjectConfig(): Promise<{ config: ProjectConfig; dbPath: string; projectRoot: string }> {
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
    console.error(
      `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
    );
    process.exit(1);
  }

  return { config, dbPath, projectRoot };
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

const SESSION_LOG_TEMPLATE = `## Shipped
(what was completed)

## Decisions
(what was decided and why)

## Rejected
(what was considered and rejected, and why)

## Gotchas
(framework issues, unexpected behaviour, things to watch for)

## TODOs
(what's next, what was deferred)
`;

export function registerSessionCommand(program: Command): void {
  const session = program
    .command('session')
    .description('Manage build sessions');

  // session start
  session
    .command('start')
    .description('Start a new build session with compiled context')
    .option('--epic <name>', 'Filter context to a specific epic')
    .option('--dry-run', 'Output context without creating a session')
    .option('--force', 'Abandon active session and start a new one')
    .action(async (opts: { epic?: string; dryRun?: boolean; force?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { createSession, getActiveSession, closeSessionSkipped } = await import('../ledger/sessions.js');
      const { compileContext, formatContextAsMarkdown } = await import('../context/compile.js');
      const { resolveChoreographyOptions } = await import('../context/choreography.js');

      const { config, dbPath, projectRoot } = await loadProjectConfig();
      const db = openDatabase(dbPath);

      try {
        // Check for active session
        const active = getActiveSession(db, config.project.id);
        if (active && !opts.force) {
          const startTime = active.started_at.slice(0, 19).replace('T', ' ');
          console.error(
            `Session ${active.id.slice(0, 8)} started at ${startTime} is still open. Close it with \`memnant session close\` or run with \`--force\` to abandon it.`,
          );
          process.exit(1);
        }

        if (active && opts.force) {
          closeSessionSkipped(db, active.id, 'abandoned by --force');
        }

        // Compile context
        const docsPath = join(projectRoot, config.governor.docs_path);
        const ctx = await compileContext(db, { epic: opts.epic, docsPath, projectRoot, projectId: config.project.id, builder: config.project.builder, choreography: resolveChoreographyOptions(config) });

        // Auto-snapshot: staleness tracking is inert without a baseline, and
        // a project that never snapshotted was previously never even warned.
        // Context is compiled first so an aging snapshot still flags stale
        // records for THIS session before the baseline resets.
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
        }

        // Create session (unless dry run)
        if (!opts.dryRun) {
          const newSession = createSession(db, config.project.id, opts.epic);
          // Print session ID to stderr so it doesn't pollute the context output
          process.stderr.write(`Session ${newSession.id.slice(0, 8)} started.\n`);
        }

        // Output compiled context
        console.log(formatContextAsMarkdown(ctx));
      } finally {
        db.close();
      }
    });

  // session close
  session
    .command('close')
    .description('Close the active session with a log')
    .option('--log <content>', 'Session log content (inline)')
    .option('--skip <reason>', 'Close without a log (provide reason)')
    .action(async (opts: { log?: string; skip?: string }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { getActiveSession, closeSession, closeSessionSkipped, getSessionRecordCounts } = await import('../ledger/sessions.js');
      const { insertRecord } = await import('../ledger/records.js');
      const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');

      const { config, dbPath, projectRoot } = await loadProjectConfig();
      const db = openDatabase(dbPath);

      try {
        const active = getActiveSession(db, config.project.id);
        if (!active) {
          console.log('No active session to close.');
          return;
        }

        // Handle --skip
        if (opts.skip !== undefined) {
          if (!opts.skip || opts.skip === 'true') {
            console.error("Provide a reason for skipping the log: `--skip 'your reason'`");
            process.exit(1);
          }
          closeSessionSkipped(db, active.id, opts.skip);
          console.error(
            'Session closed without log. Context from this session will not be available in future sessions.',
          );
          printCloseSummary(getSessionRecordCounts, db, active);
          return;
        }

        // Get log content from --log flag or piped stdin
        let content = opts.log;
        if (!content && !process.stdin.isTTY) {
          content = readStdin().trim();
        }

        // If no content from either source, print template and read stdin
        if (!content) {
          process.stderr.write('Enter session log (Ctrl+D to finish):\n\n');
          process.stderr.write(SESSION_LOG_TEMPLATE);
          process.stderr.write('\n---\n');
          content = readStdin().trim();
        }

        if (!content) {
          console.error('No log content provided. Use --log, pipe from stdin, or enter interactively.');
          process.exit(1);
        }

        // Generate embedding and insert session_log record
        const embedding = await generateEmbedding(content);
        const embeddingBuffer = serializeEmbedding(embedding);

        const record = insertRecord(db, {
          projectId: config.project.id,
          type: 'session_log',
          contentText: content,
          embedding: embeddingBuffer,
          sourceSession: active.id,
        });

        closeSession(db, active.id, record.id);

        // Team export parity with MCP session_close: ship this session's
        // shareable records into .memnant/shared/ so subagents without MCP
        // access still contribute to PRs. Only in team mode (builder set).
        const builder = (config.project as any).builder;
        if (builder) {
          try {
            const { exportSharedRecords } = await import('../team/sync.js');
            const sharedDir = join(projectRoot, '.memnant', 'shared');
            const exportCount = exportSharedRecords(
              db,
              active.id,
              config.project.id,
              sharedDir,
              builder,
              config.project.name,
            );
            if (exportCount > 0) {
              process.stderr.write(
                `team sync: exported ${exportCount} record${exportCount > 1 ? 's' : ''} to .memnant/shared/\n`,
              );
            }
          } catch (err) {
            process.stderr.write(`team sync export failed (non-blocking): ${err}\n`);
          }
        }

        printCloseSummary(getSessionRecordCounts, db, active);
      } finally {
        db.close();
      }
    });

  // session status
  session
    .command('status')
    .description('Show active session info')
    .action(async () => {
      const { openDatabase } = await import('../ledger/database.js');
      const { getActiveSession, getSessionRecordCounts } = await import('../ledger/sessions.js');

      const { config, dbPath } = await loadProjectConfig();
      const db = openDatabase(dbPath);

      try {
        const active = getActiveSession(db, config.project.id);
        if (!active) {
          console.log('No active session.');
          return;
        }

        const duration = formatDuration(
          new Date(active.started_at),
          new Date(),
        );
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
      } finally {
        db.close();
      }
    });
}

function printCloseSummary(
  getSessionRecordCounts: (db: import('../ledger/database.js').Database, sessionId: string) => Record<string, number>,
  db: import('../ledger/database.js').Database,
  session: import('../types.js').Session,
): void {
  const duration = formatDuration(new Date(session.started_at), new Date());
  const counts = getSessionRecordCounts(db, session.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log(`Session ${session.id.slice(0, 8)} closed.`);
  console.log(`Duration: ${duration}`);
  console.log(`Records created: ${total}`);
  if (total > 0) {
    for (const [type, count] of Object.entries(counts)) {
      console.log(`  ${type}: ${count}`);
    }
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

/**
 * memnant — Session lifecycle management for MCP server.
 *
 * Story 8.1: Auto-start session on first mutating MCP tool call.
 * Story 8.2: Auto-close sessions after idle timeout.
 * Story 8.4: Stale session cleanup (sessions open > max_duration_hours).
 */

import type { Database } from '../ledger/database.js';
import type { Session, ProjectConfig } from '../types.js';
import { getActiveSession, createSession, closeSession } from '../ledger/sessions.js';
import { insertRecord } from '../ledger/records.js';
import { generateEmbedding, serializeEmbedding } from '../vector/embeddings.js';
import { getSessionRecordCounts } from '../ledger/sessions.js';

const DEFAULT_AUTO_CLOSE_MINUTES = 60;
const DEFAULT_MAX_DURATION_HOURS = 8;

export interface SessionManagerState {
  lastToolCallAt: number;
  intervalHandle: ReturnType<typeof setInterval> | null;
}

/**
 * Ensure an active session exists. If none, create one automatically.
 * Used by mutating tools (log, session_context) — not by read-only tools.
 */
export function ensureActiveSession(
  db: Database,
  projectId: string,
): Session {
  const active = getActiveSession(db, projectId);
  if (active) return active;
  return createSession(db, projectId);
}

/**
 * Check and close a session that has been idle longer than auto_close_minutes.
 * Returns true if a session was auto-closed.
 */
export async function autoCloseIdleSession(
  db: Database,
  config: ProjectConfig,
  state: SessionManagerState,
): Promise<boolean> {
  const active = getActiveSession(db, config.project.id);
  if (!active) return false;

  const autoCloseMinutes = config.session?.auto_close_minutes ?? DEFAULT_AUTO_CLOSE_MINUTES;
  const idleMs = Date.now() - state.lastToolCallAt;
  const idleMinutes = idleMs / 60000;

  if (idleMinutes < autoCloseMinutes) return false;

  await autoCloseSession(db, config, active, 'idle');
  return true;
}

/**
 * Check and close a session that has been open longer than max_duration_hours.
 * Returns true if a session was auto-closed.
 */
export async function autoCloseStaleSession(
  db: Database,
  config: ProjectConfig,
): Promise<boolean> {
  const active = getActiveSession(db, config.project.id);
  if (!active) return false;

  const maxDurationHours = config.session?.max_duration_hours ?? DEFAULT_MAX_DURATION_HOURS;
  const sessionAgeMs = Date.now() - new Date(active.started_at).getTime();
  const sessionAgeHours = sessionAgeMs / (1000 * 60 * 60);

  if (sessionAgeHours < maxDurationHours) return false;

  await autoCloseSession(db, config, active, 'stale');
  return true;
}

/**
 * Generate an auto-close session log and close the session.
 */
async function autoCloseSession(
  db: Database,
  config: ProjectConfig,
  session: Session,
  reason: 'idle' | 'stale',
): Promise<void> {
  const log = generateAutoCloseLog(db, session, reason);
  const embedding = await generateEmbedding(log);
  const embeddingBuffer = serializeEmbedding(embedding);

  const tags = ['auto-closed', reason];

  const record = insertRecord(db, {
    projectId: config.project.id,
    type: 'session_log',
    contentText: log,
    tags,
    embedding: embeddingBuffer,
    sourceSession: session.id,
  });

  closeSession(db, session.id, record.id);
}

/**
 * Generate a mechanical auto-close log (no LLM needed).
 */
export function generateAutoCloseLog(
  db: Database,
  session: Session,
  reason: 'idle' | 'stale',
): string {
  const startMs = new Date(session.started_at).getTime();
  const durationMs = Date.now() - startMs;
  const minutes = Math.floor(durationMs / 60000);
  const hours = Math.floor(minutes / 60);
  const durationStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

  const counts = getSessionRecordCounts(db, session.id);
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

  const reasonLabel = reason === 'idle' ? 'idle timeout' : 'max duration exceeded';

  const countLines = Object.entries(counts)
    .map(([type, count]) => `  - ${count} ${type}`)
    .join('\n');

  return `## Auto-closed session (${reasonLabel})
Duration: ${durationStr}
Records created: ${totalRecords}
${countLines ? countLines : '  - none'}`;
}

/**
 * Run all auto-close checks. Called on every tool call and by the interval timer.
 */
export async function runAutoCloseChecks(
  db: Database,
  config: ProjectConfig,
  state: SessionManagerState,
): Promise<void> {
  // Check stale first (longer duration takes priority)
  const closedStale = await autoCloseStaleSession(db, config);
  if (closedStale) {
    process.stderr.write(`[${new Date().toISOString()}] Auto-closed stale session (max duration exceeded)\n`);
    return;
  }

  const closedIdle = await autoCloseIdleSession(db, config, state);
  if (closedIdle) {
    process.stderr.write(`[${new Date().toISOString()}] Auto-closed idle session\n`);
  }
}

/**
 * Start the periodic auto-close interval timer.
 */
export function startAutoCloseTimer(
  db: Database,
  config: ProjectConfig,
  state: SessionManagerState,
): void {
  // Check every 5 minutes
  state.intervalHandle = setInterval(async () => {
    try {
      await runAutoCloseChecks(db, config, state);
    } catch (err) {
      process.stderr.write(`[${new Date().toISOString()}] Auto-close check error: ${err}\n`);
    }
  }, 5 * 60 * 1000);

  // Don't prevent process exit
  if (state.intervalHandle.unref) {
    state.intervalHandle.unref();
  }
}

/**
 * Stop the auto-close timer.
 */
export function stopAutoCloseTimer(state: SessionManagerState): void {
  if (state.intervalHandle) {
    clearInterval(state.intervalHandle);
    state.intervalHandle = null;
  }
}

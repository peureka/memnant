/**
 * Tests for Epic 8: Invisible Sessions.
 *
 * Story 8.1: Auto-start session on first MCP tool call.
 * Story 8.2: Auto-close sessions on idle timeout.
 * Story 8.4: Stale session cleanup.
 *
 * Tests pass past timestamps to simulate idle/stale conditions — no actual waiting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createDatabase, openDatabase, type Database } from '../src/ledger/database.js';
import { createSession, getActiveSession } from '../src/ledger/sessions.js';
import {
  ensureActiveSession,
  autoCloseIdleSession,
  autoCloseStaleSession,
  generateAutoCloseLog,
  type SessionManagerState,
} from '../src/mcp/session-manager.js';
import type { ProjectConfig } from '../src/types.js';

const PROJECT_ID = 'test-project-id';

function makeConfig(overrides?: Partial<ProjectConfig['session']>): ProjectConfig {
  return {
    project: { name: 'test', id: PROJECT_ID },
    memory: {
      db_path: '.memnant/ledger.db',
      export_path: '.memnant/export/',
      snapshot_interval: 'monthly',
      max_spec_snapshots: 5,
      max_codebase_snapshots: 3,
    },
    orchestrator: {
      tiers: {
        triage: { provider: 'anthropic', model: 'test' },
        analysis: { provider: 'anthropic', model: 'test' },
        build: { provider: 'anthropic', model: 'test' },
      },
      interfaces: {
        telegram: { enabled: false },
        cli: { enabled: true },
        mcp: { enabled: true, port: 3100 },
      },
    },
    governor: { docs_path: 'docs/', lint_on_pr: false, strict_mode: false },
    security: { staging_only: true, allow_deploy: false, allowed_mcp_tools: [] },
    session: overrides,
  } as ProjectConfig;
}

describe('Epic 8: Invisible Sessions', () => {
  let testDir: string;
  let db: Database;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-session-'));
    const dbPath = join(testDir, 'ledger.db');
    db = createDatabase(dbPath);
    db.run(
      "INSERT INTO project (id, name, root_path, created_at) VALUES (?, 'test', ?, ?)",
      [PROJECT_ID, testDir, new Date().toISOString()],
    );
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Story 8.1: Auto-start session', () => {
    it('opens a second caller connection when another writer briefly holds the ledger', async () => {
      const path = join(testDir, 'ledger.db');
      const writer = spawn(process.execPath, ['-e', `
        const { Database } = require('node-sqlite3-wasm');
        const db = new Database(process.argv[1]);
        db.run('BEGIN EXCLUSIVE');
        process.send('locked');
        setTimeout(() => { db.run('COMMIT'); db.close(); }, 300);
      `, path], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const exit = once(writer, 'exit');
      try {
        const [ready] = await Promise.race([once(writer, 'message'), exit]);
        expect(ready).toBe('locked');
        const second = openDatabase(path, 'second-caller');
        try { expect(second.get('SELECT id FROM project')?.id).toBe(PROJECT_ID); }
        finally { second.close(); }
      } finally { await exit; }
    });

    it('runs stale cleanup only for the calling owner', async () => {
      const a = ensureActiveSession(db, PROJECT_ID, 'a');
      const b = ensureActiveSession(db, PROJECT_ID, 'b');
      db.run("UPDATE session SET started_at = '2000-01-01' WHERE id IN (?, ?)", [a.id, b.id]);
      expect(await autoCloseStaleSession(db, makeConfig(), 'b')).toBe(true);
      expect(getActiveSession(db, PROJECT_ID, 'b')).toBeNull();
      expect(getActiveSession(db, PROJECT_ID, 'a')?.id).toBe(a.id);
    });

    it('runs idle cleanup for only the caller whose timer elapsed', async () => {
      const a = ensureActiveSession(db, PROJECT_ID, 'a');
      const b = ensureActiveSession(db, PROJECT_ID, 'b');
      const state = { owner: 'a', lastToolCallAt: 0, intervalHandle: null };
      expect(await autoCloseIdleSession(db, makeConfig(), state)).toBe(true);
      expect(getActiveSession(db, PROJECT_ID, 'a')).toBeNull();
      expect(getActiveSession(db, PROJECT_ID, 'b')?.id).toBe(b.id);
      expect(a.id).not.toBe(b.id);
    });

    it('allows at most one open row for a named owner even when two starters reach the ledger', () => {
      createSession(db, PROJECT_ID, undefined, 'resumed');
      expect(() => createSession(db, PROJECT_ID, undefined, 'resumed')).toThrow();
      expect(db.get("SELECT COUNT(*) AS n FROM session WHERE owner_key = 'resumed' AND closed_at IS NULL")).toEqual({ n: 1 });
    });

    it('keeps a stable, distinct active session per caller in the same project', () => {
      const first = ensureActiveSession(db, PROJECT_ID, 'caller-a');
      const second = ensureActiveSession(db, PROJECT_ID, 'caller-b');

      expect(second.id).not.toBe(first.id);
      expect(ensureActiveSession(db, PROJECT_ID, 'caller-a').id).toBe(first.id);
      expect(getActiveSession(db, PROJECT_ID)).toBeNull();
    });

    it('creates a new session if none exists', () => {
      const session = ensureActiveSession(db, PROJECT_ID);
      expect(session).toBeTruthy();
      expect(session.id).toBeTruthy();
      expect(session.closed_at).toBeNull();
    });

    it('returns existing session if one is active', () => {
      const first = ensureActiveSession(db, PROJECT_ID);
      const second = ensureActiveSession(db, PROJECT_ID);
      expect(first.id).toBe(second.id);
    });

    it('creates a new session after the previous one was closed', () => {
      const first = createSession(db, PROJECT_ID);
      db.run("UPDATE session SET closed_at = ? WHERE id = ?", [new Date().toISOString(), first.id]);

      const second = ensureActiveSession(db, PROJECT_ID);
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('Story 8.2: Auto-close idle session', () => {
    it('does not close a session within the timeout window', async () => {
      createSession(db, PROJECT_ID);
      const state: SessionManagerState = {
        lastToolCallAt: Date.now() - 30 * 60 * 1000, // 30 min ago
        intervalHandle: null,
      };
      const config = makeConfig({ auto_close_minutes: 60 });

      const closed = await autoCloseIdleSession(db, config, state);
      expect(closed).toBe(false);

      const active = getActiveSession(db, PROJECT_ID);
      expect(active).not.toBeNull();
    });

    it('closes a session after the timeout window', async () => {
      createSession(db, PROJECT_ID);
      const state: SessionManagerState = {
        lastToolCallAt: Date.now() - 90 * 60 * 1000, // 90 min ago
        intervalHandle: null,
      };
      const config = makeConfig({ auto_close_minutes: 60 });

      const closed = await autoCloseIdleSession(db, config, state);
      expect(closed).toBe(true);

      const active = getActiveSession(db, PROJECT_ID);
      expect(active).toBeNull();
    });

    it('uses default 60-minute timeout when not configured', async () => {
      createSession(db, PROJECT_ID);
      const state: SessionManagerState = {
        lastToolCallAt: Date.now() - 61 * 60 * 1000,
        intervalHandle: null,
      };
      const config = makeConfig(); // no session config

      const closed = await autoCloseIdleSession(db, config, state);
      expect(closed).toBe(true);
    });

    it('does nothing when no active session exists', async () => {
      const state: SessionManagerState = {
        lastToolCallAt: Date.now() - 120 * 60 * 1000,
        intervalHandle: null,
      };
      const config = makeConfig({ auto_close_minutes: 60 });

      const closed = await autoCloseIdleSession(db, config, state);
      expect(closed).toBe(false);
    });
  });

  describe('Story 8.4: Stale session cleanup', () => {
    it('does not close a session within max duration', async () => {
      createSession(db, PROJECT_ID);
      const config = makeConfig({ max_duration_hours: 8 });

      const closed = await autoCloseStaleSession(db, config);
      expect(closed).toBe(false);
    });

    it('closes a session that exceeds max duration', async () => {
      // Create a session with a started_at 9 hours ago
      const session = createSession(db, PROJECT_ID);
      const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      db.run('UPDATE session SET started_at = ? WHERE id = ?', [nineHoursAgo, session.id]);

      const config = makeConfig({ max_duration_hours: 8 });

      const closed = await autoCloseStaleSession(db, config);
      expect(closed).toBe(true);

      const active = getActiveSession(db, PROJECT_ID);
      expect(active).toBeNull();
    });

    it('uses default 8-hour duration when not configured', async () => {
      const session = createSession(db, PROJECT_ID);
      const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString();
      db.run('UPDATE session SET started_at = ? WHERE id = ?', [nineHoursAgo, session.id]);

      const config = makeConfig(); // no session config

      const closed = await autoCloseStaleSession(db, config);
      expect(closed).toBe(true);
    });
  });

  describe('generateAutoCloseLog', () => {
    it('generates a mechanical log for idle sessions', () => {
      const session = createSession(db, PROJECT_ID);
      const log = generateAutoCloseLog(db, session, 'idle');

      expect(log).toContain('Auto-closed session (idle timeout)');
      expect(log).toContain('Duration:');
      expect(log).toContain('Records created: 0');
    });

    it('generates a mechanical log for stale sessions', () => {
      const session = createSession(db, PROJECT_ID);
      const log = generateAutoCloseLog(db, session, 'stale');

      expect(log).toContain('Auto-closed session (max duration exceeded)');
    });
  });
});

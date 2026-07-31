/**
 * memnant session hook — install a Claude Code SessionStart hook.
 *
 * The hook auto-starts a memnant session every time Claude Code launches in a
 * project that has already been initialised. It writes into the user's
 * ~/.claude/settings.json, which holds their entire Claude Code config, so the
 * installer is conservative: it merges, it never rewrites from scratch, and it
 * aborts without writing if the file cannot be parsed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export type SessionHookResult = 'installed' | 'updated' | 'skipped' | 'aborted';

/** Marker used to recognise a memnant hook already present in settings.json. */
const HOOK_MARKER = 'memnant session start';

/**
 * Start a session only when the project is initialised. `session status`
 * prints "No active session." exactly when a ledger exists and is idle, so
 * this no-ops silently in every other directory.
 */
const SESSION_START_COMMAND =
  'npx -y memnant session status 2>/dev/null | grep -q "No active session" && npx -y memnant session start >/dev/null 2>&1 || true';

/**
 * Opt-in variant: also initialise memnant at git roots that do not have it
 * yet, and keep `.memnant/` out of the repo.
 */
const AUTO_INIT_COMMAND =
  "{ [ -d .git ] && [ ! -f memnant.yaml ] && npx -y memnant init --non-interactive >/dev/null 2>&1 && { grep -qxF '.memnant/' .gitignore 2>/dev/null || echo '.memnant/' >> .gitignore; }; npx -y memnant session status 2>/dev/null | grep -q \"No active session\" && npx -y memnant session start >/dev/null 2>&1; } || true";

export interface SessionHookOptions {
  /** Also run `memnant init` at git roots that have no ledger yet. */
  autoInit?: boolean;
  /** Override the settings file location. Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
}

function hookCommand(autoInit: boolean): string {
  return autoInit ? AUTO_INIT_COMMAND : SESSION_START_COMMAND;
}

function hookEntry(autoInit: boolean): Record<string, unknown> {
  return {
    type: 'command',
    command: hookCommand(autoInit),
    async: true,
    timeout: 600,
    statusMessage: 'Starting memnant session',
  };
}

/**
 * Refuse to touch a settings file we do not fully understand. This file is the
 * user's entire Claude Code config — overwriting it with a fresh object on a
 * parse failure would destroy their model, permissions, and other hooks.
 */
function abort(settingsPath: string, reason: string): void {
  console.error(
    `Skipped the memnant session hook: ${settingsPath} could not be read because ${reason}.`,
  );
  console.error(
    'Nothing was written — that file holds your whole Claude Code config. ' +
      "Fix it (or move it aside) and run 'memnant setup claude-code' again.",
  );
}

/**
 * Find a memnant hook entry anywhere in the SessionStart matcher groups.
 * Matching is on the command substring, so hand-installed variants are found
 * too — not just the exact commands this file writes.
 */
function findMemnantEntry(sessionStart: unknown[]): Record<string, unknown> | null {
  for (const group of sessionStart) {
    if (!group || typeof group !== 'object') continue;
    const entries = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const command = (entry as Record<string, unknown>).command;
      if (typeof command === 'string' && command.includes(HOOK_MARKER)) {
        return entry as Record<string, unknown>;
      }
    }
  }
  return null;
}

export function installClaudeSessionHook(options: SessionHookOptions = {}): SessionHookResult {
  const settingsPath = options.settingsPath ?? join(homedir(), '.claude', 'settings.json');
  const autoInit = options.autoInit ?? false;

  // The hook is POSIX sh. Claude Code on Windows without Git Bash runs hooks
  // through PowerShell, where this command would fail on every launch.
  if (process.platform === 'win32') {
    console.log('Session hook skipped: not supported on Windows yet. Everything else is set up.');
    return 'skipped';
  }

  let data: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      abort(settingsPath, `it is not valid JSON (${msg})`);
      return 'aborted';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      abort(settingsPath, `it does not contain a JSON object at the top level`);
      return 'aborted';
    }
    data = parsed as Record<string, unknown>;
  }

  if (data.hooks === undefined) {
    data.hooks = {};
  }
  if (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks)) {
    abort(settingsPath, `"hooks" is not an object`);
    return 'aborted';
  }
  const hooks = data.hooks as Record<string, unknown>;

  if (hooks.SessionStart === undefined) {
    hooks.SessionStart = [];
  }
  if (!Array.isArray(hooks.SessionStart)) {
    abort(settingsPath, `"hooks.SessionStart" is not an array`);
    return 'aborted';
  }
  const sessionStart = hooks.SessionStart as unknown[];

  const existing = findMemnantEntry(sessionStart);
  let result: SessionHookResult;

  if (existing) {
    if (existing.command === hookCommand(autoInit)) {
      console.log('Claude Code session hook already installed.');
      return 'skipped';
    }
    // Swap the command, leave the user's other fields on that entry alone.
    existing.command = hookCommand(autoInit);
    result = 'updated';
  } else {
    sessionStart.push({ hooks: [hookEntry(autoInit)] });
    result = 'installed';
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(
    result === 'updated'
      ? 'Claude Code session hook updated.'
      : 'Claude Code session hook installed (auto-starts memnant sessions).',
  );
  return result;
}

export { SESSION_START_COMMAND, AUTO_INIT_COMMAND, HOOK_MARKER };

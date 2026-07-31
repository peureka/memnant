/**
 * Tests for the Claude Code SessionStart hook installer.
 *
 * Every test injects a settingsPath inside a temp dir. The real
 * ~/.claude/settings.json is never read or written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { installClaudeSessionHook } from '../src/cli/session-hook.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

describe('installClaudeSessionHook', () => {
  let testDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-hook-')));
    settingsPath = join(testDir, '.claude', 'settings.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  it('creates the settings file when it does not exist', () => {
    const result = installClaudeSessionHook({ settingsPath });

    expect(result).toBe('installed');
    expect(existsSync(settingsPath)).toBe(true);

    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(data.hooks.SessionStart).toHaveLength(1);

    const entry = data.hooks.SessionStart[0].hooks[0];
    expect(entry.type).toBe('command');
    expect(entry.async).toBe(true);
    expect(entry.timeout).toBe(600);
    expect(entry.statusMessage).toBe('Starting memnant session');
    expect(entry.command).toContain('memnant session start');
    expect(entry.command).not.toContain('memnant init');
  });

  it('merges into existing settings without disturbing other content', () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          permissions: { allow: ['Bash(npm run test)'] },
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = installClaudeSessionHook({ settingsPath });
    expect(result).toBe('installed');

    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(data.model).toBe('opus');
    expect(data.permissions.allow).toEqual(['Bash(npm run test)']);
    expect(data.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] },
    ]);
    expect(data.hooks.SessionStart).toHaveLength(2);
    expect(data.hooks.SessionStart[0].hooks[0].command).toBe('echo hello');
    expect(data.hooks.SessionStart[1].hooks[0].command).toContain('memnant session start');
  });

  it('skips without writing when the same hook is already installed', () => {
    expect(installClaudeSessionHook({ settingsPath })).toBe('installed');
    const afterFirst = readFileSync(settingsPath, 'utf-8');

    const result = installClaudeSessionHook({ settingsPath });

    expect(result).toBe('skipped');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(afterFirst);
    const data = JSON.parse(afterFirst);
    expect(data.hooks.SessionStart).toHaveLength(1);
  });

  it('updates an existing memnant entry in place when the command differs', () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo hello' }] },
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'npx memnant session start',
                    async: true,
                    statusMessage: 'Starting memnant session',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = installClaudeSessionHook({ settingsPath, autoInit: true });

    expect(result).toBe('updated');
    const data = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(data.model).toBe('opus');
    expect(data.hooks.SessionStart).toHaveLength(2);
    expect(data.hooks.SessionStart[0].hooks[0].command).toBe('echo hello');

    const entry = data.hooks.SessionStart[1].hooks[0];
    expect(entry.command).toContain('memnant init --non-interactive');
    expect(entry.command).toContain('memnant session start');
    // Everything else on that entry is left as the user had it.
    expect(entry.async).toBe(true);
    expect(entry.statusMessage).toBe('Starting memnant session');
    expect(entry.timeout).toBeUndefined();
  });

  it('aborts without writing when settings.json is malformed', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });

    mkdirSync(dirname(settingsPath), { recursive: true });
    const original = '{ "model": "opus", // a comment breaks JSON\n  "hooks": {}\n';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = installClaudeSessionHook({ settingsPath });

    expect(result).toBe('aborted');
    // The user's config is untouched, byte for byte.
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
    const message = errors.join('\n');
    expect(message).toContain(settingsPath);
    expect(message).toContain('Nothing was written');
  });

  it('aborts without writing when settings.json is not a JSON object', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(dirname(settingsPath), { recursive: true });
    const original = '["not", "an", "object"]\n';
    writeFileSync(settingsPath, original, 'utf-8');

    expect(installClaudeSessionHook({ settingsPath })).toBe('aborted');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('aborts without writing when hooks.SessionStart has an unexpected shape', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mkdirSync(dirname(settingsPath), { recursive: true });
    const original = JSON.stringify({ hooks: { SessionStart: 'echo hi' } }, null, 2);
    writeFileSync(settingsPath, original, 'utf-8');

    expect(installClaudeSessionHook({ settingsPath })).toBe('aborted');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('skips on Windows without writing or erroring', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const result = installClaudeSessionHook({ settingsPath });
      expect(result).toBe('skipped');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    expect(existsSync(settingsPath)).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('Windows');
  });
});

describe('memnant setup claude-code — session hook wiring', () => {
  let testDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-hook-cli-')));
    fakeHome = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-home-')));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  function settingsIn(home: string): Record<string, any> {
    return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
  }

  it('installs the session hook alongside MCP registration', () => {
    const result = runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Claude Code session hook installed');

    const entry = settingsIn(fakeHome).hooks.SessionStart[0].hooks[0];
    expect(entry.command).toContain('memnant session start');
    expect(entry.command).not.toContain('memnant init');
    expect(entry.timeout).toBe(600);
  });

  it('installs the session hook during init, when Claude Code is detected', () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{}', 'utf-8');

    const result = runMemnant(['init', '--non-interactive'], testDir, { HOME: fakeHome });

    expect(result.status).toBe(0);
    const entry = settingsIn(fakeHome).hooks.SessionStart[0].hooks[0];
    expect(entry.command).toContain('memnant session start');
    expect(entry.command).not.toContain('memnant init');
  });

  it('installs the auto-init variant with --auto-init', () => {
    const result = runMemnant(['setup', 'claude-code', '--auto-init'], testDir, { HOME: fakeHome });

    expect(result.status).toBe(0);
    const entry = settingsIn(fakeHome).hooks.SessionStart[0].hooks[0];
    expect(entry.command).toContain('memnant init --non-interactive');
    expect(entry.command).toContain('memnant session start');
  });
});

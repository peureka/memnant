/**
 * Lockstep tests for the Claude Code plugin distribution.
 *
 * The plugin ships the same two things the npm installer configures — the MCP
 * server and the SessionStart hook — but as static JSON that Claude Code reads
 * directly. Nothing regenerates those files, so they drift silently the moment
 * someone edits the installer. These tests are the tie: the plugin JSON is
 * asserted against the exact constants the installer writes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SESSION_START_COMMAND } from '../src/cli/session-hook.js';
import { getMcpServerConfig } from '../src/cli/setup.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'claude-plugin');

function readJson(...segments: string[]): Record<string, unknown> {
  const path = join(...segments);
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  expect(parsed, `${path} should hold a JSON object`).toBeTypeOf('object');
  return parsed as Record<string, unknown>;
}

describe('claude-plugin/hooks/hooks.json', () => {
  it('registers exactly one SessionStart hook', () => {
    const hooks = readJson(PLUGIN_ROOT, 'hooks', 'hooks.json');
    const sessionStart = (hooks.hooks as Record<string, unknown>).SessionStart;

    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart as unknown[]).toHaveLength(1);

    const entries = ((sessionStart as unknown[])[0] as Record<string, unknown>).hooks;
    expect(entries as unknown[]).toHaveLength(1);
  });

  it('runs the same command the npm installer writes', () => {
    const hooks = readJson(PLUGIN_ROOT, 'hooks', 'hooks.json');
    const sessionStart = (hooks.hooks as Record<string, unknown>).SessionStart as unknown[];
    const entry = ((sessionStart[0] as Record<string, unknown>).hooks as unknown[])[0] as Record<
      string,
      unknown
    >;

    expect(entry.type).toBe('command');
    expect(entry.command).toBe(SESSION_START_COMMAND);
    expect(entry.async).toBe(true);
    expect(entry.timeout).toBe(600);
    expect(entry.statusMessage).toBe('Starting memnant session');
  });

  it('ships the session-start command, not the auto-init variant', () => {
    // Auto-init writes to the user's repo (memnant init, .gitignore). That
    // stays an explicit CLI opt-in; installing a plugin must never do it.
    const hooks = readJson(PLUGIN_ROOT, 'hooks', 'hooks.json');
    const raw = JSON.stringify(hooks);

    expect(raw).not.toContain('memnant init');
    expect(raw).not.toContain('.gitignore');
  });
});

describe('claude-plugin/.mcp.json', () => {
  it('launches the server exactly as the npm installer does', () => {
    const mcp = readJson(PLUGIN_ROOT, '.mcp.json');
    const servers = mcp.mcpServers as Record<string, unknown>;
    const memnant = servers.memnant as Record<string, unknown>;

    const expected = getMcpServerConfig();
    expect(memnant.command).toBe(expected.command);
    expect(memnant.args).toEqual(expected.args);
    expect(memnant.type).toBe('stdio');
  });

  it('registers only the memnant server', () => {
    const mcp = readJson(PLUGIN_ROOT, '.mcp.json');
    expect(Object.keys(mcp.mcpServers as Record<string, unknown>)).toEqual(['memnant']);
  });
});

describe('.claude-plugin/marketplace.json', () => {
  it('lists the memnant plugin at ./claude-plugin', () => {
    const marketplace = readJson(REPO_ROOT, '.claude-plugin', 'marketplace.json');

    expect(marketplace.name).toBe('memnant');
    expect((marketplace.owner as Record<string, unknown>).name).toBeTruthy();

    const plugins = marketplace.plugins as Record<string, unknown>[];
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('memnant');
    expect(plugins[0].name as string).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(plugins[0].source).toBe('./claude-plugin');
    expect(plugins[0].description).toBeTruthy();
  });
});

describe('claude-plugin/.claude-plugin/plugin.json', () => {
  it('names the plugin memnant', () => {
    const plugin = readJson(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
    expect(plugin.name).toBe('memnant');
    expect(plugin.description).toBeTruthy();
  });

  it('carries no version field, so git commits are the version', () => {
    // A git-sourced plugin with no declared version is tracked by commit SHA:
    // every merge to main is an update users can pull, with nothing to bump.
    const plugin = readJson(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
    expect(Object.keys(plugin)).not.toContain('version');
  });

  it('declares no inline hooks or MCP servers', () => {
    // One source each: hooks live in hooks/hooks.json, servers in .mcp.json.
    // Inline copies here would be a second place to drift from the installer.
    const plugin = readJson(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
    expect(Object.keys(plugin)).not.toContain('hooks');
    expect(Object.keys(plugin)).not.toContain('mcpServers');
  });
});

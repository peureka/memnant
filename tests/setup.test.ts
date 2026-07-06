/**
 * Tests for memnant setup command.
 *
 * Verifies MCP server auto-configuration for claude-code and codex.
 * Uses HOME override to avoid writing to real config files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

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
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('memnant setup claude-code', () => {
  let testDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    // realpathSync resolves macOS /tmp → /private/tmp so paths match process.cwd() in child
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-setup-')));
    fakeHome = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-home-')));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('creates ~/.claude.json if it does not exist', () => {
    const result = runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('memnant MCP server registered for Claude Code');

    const configPath = join(fakeHome, '.claude.json');
    expect(existsSync(configPath)).toBe(true);

    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(data.projects[testDir].mcpServers.memnant).toBeDefined();
    expect(data.projects[testDir].mcpServers.memnant.type).toBe('stdio');
    expect(data.projects[testDir].mcpServers.memnant.command).toBe('npx');
    expect(data.projects[testDir].mcpServers.memnant.args).toEqual(['-y', 'memnant', 'serve']);
  });

  it('preserves existing config when adding memnant', () => {
    const configPath = join(fakeHome, '.claude.json');
    writeFileSync(configPath, JSON.stringify({ existingKey: true }, null, 2), 'utf-8');

    runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });

    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(data.existingKey).toBe(true);
    expect(data.projects[testDir].mcpServers.memnant).toBeDefined();
  });

  it('warns if memnant is not initialised', () => {
    const result = runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    expect(result.stdout).toContain("Run 'memnant init' first");
  });

  it('does not warn if memnant is initialised', () => {
    // Init first
    runMemnant(['init'], testDir);
    const result = runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    expect(result.stdout).not.toContain("Run 'memnant init' first");
  });
});

describe('memnant setup claude-code — CLAUDE.md injection', () => {
  let testDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-setup-')));
    fakeHome = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-home-')));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('creates CLAUDE.md if missing', () => {
    runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    const claudeMd = join(testDir, 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# memnant');
    expect(content).toContain('MCP Tools');
  });

  it('appends to existing CLAUDE.md', () => {
    writeFileSync(join(testDir, 'CLAUDE.md'), '# My Project\n\nExisting content.\n', 'utf-8');
    runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Existing content.');
    expect(content).toContain('# memnant');
  });

  it('does not duplicate on re-run', () => {
    runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    runMemnant(['setup', 'claude-code'], testDir, { HOME: fakeHome });
    const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
    const matches = content.match(/^# memnant$/gm);
    expect(matches).toHaveLength(1);
  });
});

describe('memnant setup codex', () => {
  let testDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-setup-')));
    fakeHome = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-home-')));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('creates ~/.codex/config.toml if it does not exist', () => {
    const result = runMemnant(['setup', 'codex'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('memnant MCP server registered for Codex');

    const configPath = join(fakeHome, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.memnant]');
    expect(content).toContain('command = "npx"');
    expect(content).toContain('memnant');
  });

  it('preserves existing config when adding memnant', () => {
    const codexDir = join(fakeHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'config.toml'),
      'model = "gpt-4"\n',
      'utf-8',
    );

    runMemnant(['setup', 'codex'], testDir, { HOME: fakeHome });

    const content = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('model = "gpt-4"');
    expect(content).toContain('[mcp_servers.memnant]');
  });

  it('warns if memnant is not initialised', () => {
    const result = runMemnant(['setup', 'codex'], testDir, { HOME: fakeHome });
    expect(result.stdout).toContain("Run 'memnant init' first");
  });
});

describe('memnant init — auto MCP registration', () => {
  let testDir: string;
  let fakeHome: string;

  beforeEach(async () => {
    testDir = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-setup-')));
    fakeHome = realpathSync(await mkdtemp(join(tmpdir(), 'memnant-home-')));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('auto-registers for Claude Code when ~/.claude.json exists', () => {
    // Seed a ~/.claude.json so auto-detect finds Claude Code
    writeFileSync(join(fakeHome, '.claude.json'), '{}', 'utf-8');

    const result = runMemnant(['init'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);

    const configPath = join(fakeHome, '.claude.json');
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(data.projects[testDir].mcpServers.memnant).toBeDefined();
    expect(data.projects[testDir].mcpServers.memnant.command).toBe('npx');
  });

  it('auto-registers for Claude Code when ~/.claude/ directory exists', () => {
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });

    const result = runMemnant(['init'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);

    const configPath = join(fakeHome, '.claude.json');
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(data.projects[testDir].mcpServers.memnant).toBeDefined();
  });

  it('auto-registers for Codex when ~/.codex/ exists', () => {
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });

    const result = runMemnant(['init'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);

    const configPath = join(fakeHome, '.codex', 'config.toml');
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.memnant]');
  });

  it('auto-registers for both agents when both are present', () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{}', 'utf-8');
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });

    const result = runMemnant(['init'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);

    // Claude Code
    const claudeData = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf-8'));
    expect(claudeData.projects[testDir].mcpServers.memnant).toBeDefined();

    // Codex
    const codexContent = readFileSync(join(fakeHome, '.codex', 'config.toml'), 'utf-8');
    expect(codexContent).toContain('[mcp_servers.memnant]');
  });

  it('prints guidance when no agents detected', () => {
    // fakeHome has no .claude.json, no .claude/, no .codex/
    const result = runMemnant(['init'], testDir, { HOME: fakeHome });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No agents detected');
    expect(result.stdout).toContain('memnant setup');
  });

  it('creates CLAUDE.md during init when Claude Code is detected', () => {
    writeFileSync(join(fakeHome, '.claude.json'), '{}', 'utf-8');

    runMemnant(['init'], testDir, { HOME: fakeHome });

    const claudeMd = join(testDir, 'CLAUDE.md');
    expect(existsSync(claudeMd)).toBe(true);
    const content = readFileSync(claudeMd, 'utf-8');
    expect(content).toContain('# memnant');
  });
});

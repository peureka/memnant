/**
 * memnant setup — Auto-configure MCP server in agent config files.
 *
 * Supports: claude-code (~/.claude.json), codex (~/.codex/config.toml)
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { isAbsolute, join } from 'path';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import * as TOML from 'smol-toml';
import { claudeCodeInstructions } from './instructions.js';
import { loadConfig, findProjectRoot } from '../config/load.js';

function getProjectInfo(): { name: string; dbPath: string } | null {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) return null;
  try {
    const config = loadConfig(projectRoot);
    return { name: config.project.name, dbPath: config.memory.db_path };
  } catch {
    return null;
  }
}

function getMcpServerConfig(): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', 'memnant', 'serve'],
  };
}

function warnIfNotInitialised(): void {
  const configPath = join(process.cwd(), 'memnant.yaml');
  if (!existsSync(configPath)) {
    console.log("Run 'memnant init' first to create the ledger.");
  }
}

export function injectClaudeMdInstructions(): void {
  const cwd = process.cwd();
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  const instructions = claudeCodeInstructions(getProjectInfo());

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes('# memnant')) {
      return; // Already injected
    }
    writeFileSync(claudeMdPath, existing.trimEnd() + '\n\n' + instructions, 'utf-8');
  } else {
    writeFileSync(claudeMdPath, instructions, 'utf-8');
  }
}

export function setupClaudeCode(): void {
  const home = homedir();
  const serverConfig = getMcpServerConfig();

  // 1. Register globally in ~/.claude/mcp.json
  const mcpJsonDir = join(home, '.claude');
  mkdirSync(mcpJsonDir, { recursive: true });
  const mcpJsonPath = join(mcpJsonDir, 'mcp.json');

  let mcpJson: Record<string, unknown> = {};
  if (existsSync(mcpJsonPath)) {
    try {
      mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    } catch {
      mcpJson = {};
    }
  }

  if (!mcpJson.mcpServers || typeof mcpJson.mcpServers !== 'object') {
    mcpJson.mcpServers = {};
  }
  const globalServers = mcpJson.mcpServers as Record<string, unknown>;
  globalServers.memnant = serverConfig;

  try {
    writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + '\n', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not write ~/.claude/mcp.json: ${msg}`);
  }

  // 2. Also register project-specific in ~/.claude.json (existing logic)
  const configPath = join(home, '.claude.json');

  let data: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      data = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Could not parse ~/.claude.json: ${msg}. Starting with empty config.`);
      data = {};
    }
  }

  const cwd = process.cwd();

  // Ensure nested structure exists
  if (!data.projects || typeof data.projects !== 'object') {
    data.projects = {};
  }
  const projects = data.projects as Record<string, Record<string, unknown>>;

  if (!projects[cwd] || typeof projects[cwd] !== 'object') {
    projects[cwd] = {};
  }

  if (!projects[cwd].mcpServers || typeof projects[cwd].mcpServers !== 'object') {
    projects[cwd].mcpServers = {};
  }

  const mcpServers = projects[cwd].mcpServers as Record<string, unknown>;
  mcpServers.memnant = {
    type: 'stdio',
    ...serverConfig,
  };

  try {
    writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Could not write ~/.claude.json: ${msg}`);
    return;
  }
  console.log('memnant MCP server registered for Claude Code in this project.');
  injectClaudeMdInstructions();
  warnIfNotInitialised();
}

export function setupCodex(): void {
  const codexDir = join(homedir(), '.codex');
  const configPath = join(codexDir, 'config.toml');

  let data: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      data = TOML.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Could not parse ~/.codex/config.toml: ${msg}. Starting with empty config.`);
      data = {};
    }
  } else {
    mkdirSync(codexDir, { recursive: true });
  }

  const serverConfig = getMcpServerConfig();

  if (!data.mcp_servers || typeof data.mcp_servers !== 'object') {
    data.mcp_servers = {};
  }

  const mcpServers = data.mcp_servers as Record<string, unknown>;
  mcpServers.memnant = {
    command: serverConfig.command,
    args: serverConfig.args,
  };

  try {
    writeFileSync(configPath, TOML.stringify(data) + '\n', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Could not write ~/.codex/config.toml: ${msg}`);
    return;
  }
  console.log('memnant MCP server registered for Codex.');
  warnIfNotInitialised();
}

export function setupGitHooks(): void {
  const cwd = process.cwd();

  // Resolve the hooks dir via git so this works in worktrees too, where
  // `.git` is a file and hooks live in the main repo's shared hooks dir.
  // `--git-path hooks` may print a path relative to cwd — resolve it.
  let hooksDir: string;
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    hooksDir = isAbsolute(raw) ? raw : join(cwd, raw);
  } catch {
    console.error('Not a git repository. Run `git init` first.');
    process.exit(1);
  }

  mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, 'pre-commit');
  const memnantHook = `
# memnant pre-commit hook
npx memnant lint --staged
`;

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes('memnant lint')) {
      console.log('memnant pre-commit hook already installed.');
      return;
    }
    // Chain with existing hook
    writeFileSync(hookPath, existing.trimEnd() + '\n' + memnantHook, { mode: 0o755 });
    console.log('memnant pre-commit hook appended to existing hook.');
  } else {
    writeFileSync(hookPath, '#!/bin/sh\n' + memnantHook, { mode: 0o755 });
    console.log('memnant pre-commit hook installed.');
  }
}

/**
 * Auto-detect available agents and register memnant for all of them.
 * Called automatically during init — no prompt needed.
 */
export function autoConfigureAgents(): string[] {
  const home = homedir();
  const configured: string[] = [];

  // Claude Code: ~/.claude.json or ~/.claude/ directory
  const claudeJsonPath = join(home, '.claude.json');
  const claudeDir = join(home, '.claude');
  if (existsSync(claudeJsonPath) || existsSync(claudeDir)) {
    setupClaudeCode();
    configured.push('claude-code');
  }

  // Codex: ~/.codex/ directory
  const codexDir = join(home, '.codex');
  if (existsSync(codexDir)) {
    setupCodex();
    configured.push('codex');
  }

  if (configured.length === 0) {
    console.log('No agents detected. Run `memnant setup <agent>` to configure later.');
  }

  return configured;
}

export function registerSetupCommand(program: Command): void {
  const setup = program
    .command('setup')
    .description('Auto-configure memnant MCP server for an AI agent');

  setup
    .command('claude-code')
    .description('Register memnant in Claude Code (~/.claude.json)')
    .action(setupClaudeCode);

  setup
    .command('codex')
    .description('Register memnant in Codex (~/.codex/config.toml)')
    .action(setupCodex);

  setup
    .command('git-hooks')
    .description('Install pre-commit hook for spec linting')
    .action(setupGitHooks);
}

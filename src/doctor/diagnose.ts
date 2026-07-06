/**
 * memnant doctor — Pure diagnostic functions.
 *
 * Each function checks a specific failure mode and returns findings.
 * No side effects, no repairs.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { VERSION } from '../version.js';
import { loadRegistry, type RegistryProject } from '../registry/registry.js';
import { loadConfig } from '../config/load.js';
import type { Finding, DoctorReport } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the memnant package root (where package.json lives). */
export function getPackageRoot(): string {
  // From dist/doctor/diagnose.js or src/doctor/diagnose.ts -> package root is 2 levels up
  return join(__dirname, '..', '..');
}

/** Check if dist/ exists and is not stale. */
export function diagnoseDist(): Finding[] {
  const findings: Finding[] = [];
  const root = getPackageRoot();
  const distEntry = join(root, 'dist', 'cli', 'index.js');
  const srcEntry = join(root, 'src', 'cli', 'index.ts');

  if (!existsSync(distEntry)) {
    findings.push({
      code: 'DIST_MISSING',
      severity: 'error',
      path: distEntry,
      message: 'dist/cli/index.js not found. memnant has not been built.',
      fixable: true,
      fix_description: 'Run tsc to compile TypeScript',
    });
    return findings;
  }

  if (existsSync(srcEntry)) {
    try {
      const srcMtime = statSync(srcEntry).mtimeMs;
      const distMtime = statSync(distEntry).mtimeMs;
      if (srcMtime > distMtime) {
        findings.push({
          code: 'DIST_STALE',
          severity: 'warning',
          path: distEntry,
          message: 'dist/ is older than source. Build may be out of date.',
          fixable: true,
          fix_description: 'Run tsc to recompile TypeScript',
        });
      }
    } catch {
      // Can't stat files, skip staleness check
    }
  }

  return findings;
}

/** Check if memnant is on PATH. */
export function diagnoseNpmLink(): Finding[] {
  try {
    execFileSync('which', ['memnant'], { encoding: 'utf-8', timeout: 5000 });
    return [];
  } catch {
    return [{
      code: 'NPM_LINK_MISSING',
      severity: 'warning',
      message: 'memnant not found on PATH. Run `npm link` from the memnant directory or `npm install -g memnant`.',
      fixable: false,
    }];
  }
}

/** Check if memnant is registered in ~/.claude/mcp.json. */
export function diagnoseMcpConfig(): Finding[] {
  const mcpJsonPath = join(homedir(), '.claude', 'mcp.json');

  if (!existsSync(mcpJsonPath)) {
    return [{
      code: 'MCP_ENTRY_MISSING',
      severity: 'error',
      path: mcpJsonPath,
      message: '~/.claude/mcp.json does not exist. memnant MCP server is not registered.',
      fixable: true,
      fix_description: 'Register memnant in Claude Code MCP config',
    }];
  }

  try {
    const data = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    const servers = data?.mcpServers;
    if (!servers || typeof servers !== 'object' || !servers.memnant) {
      return [{
        code: 'MCP_ENTRY_MISSING',
        severity: 'error',
        path: mcpJsonPath,
        message: 'memnant not found in ~/.claude/mcp.json mcpServers.',
        fixable: true,
        fix_description: 'Register memnant in Claude Code MCP config',
      }];
    }
  } catch {
    return [{
      code: 'MCP_ENTRY_MISSING',
      severity: 'error',
      path: mcpJsonPath,
      message: '~/.claude/mcp.json is not valid JSON.',
      fixable: true,
      fix_description: 'Recreate Claude Code MCP config with memnant entry',
    }];
  }

  return [];
}

/** Check a single registered project for infrastructure issues. */
export function diagnoseProject(project: RegistryProject): Finding[] {
  const findings: Finding[] = [];

  if (!existsSync(project.root_path)) {
    findings.push({
      code: 'PROJECT_DIR_MISSING',
      severity: 'error',
      project: project.name,
      path: project.root_path,
      message: `Project directory does not exist: ${project.root_path}`,
      fixable: true,
      fix_description: 'Remove stale project from registry',
    });
    return findings;
  }

  const configPath = join(project.root_path, 'memnant.yaml');
  if (!existsSync(configPath)) {
    findings.push({
      code: 'CONFIG_MISSING',
      severity: 'error',
      project: project.name,
      path: configPath,
      message: `memnant.yaml not found in ${project.root_path}. Run \`memnant init\`.`,
      fixable: false,
    });
    return findings;
  }

  // Parse config to find db_path
  try {
    const config = loadConfig(project.root_path);
    const dbPath = join(project.root_path, config.memory.db_path);

    if (!existsSync(dbPath)) {
      findings.push({
        code: 'LEDGER_MISSING',
        severity: 'error',
        project: project.name,
        path: dbPath,
        message: `Ledger database not found at ${config.memory.db_path}. Config exists but database is missing.`,
        fixable: true,
        fix_description: 'Create ledger database with schema',
      });
    }
  } catch {
    // Config parse failed — check default path
    const defaultDbPath = join(project.root_path, '.memnant', 'ledger.db');
    if (!existsSync(defaultDbPath)) {
      findings.push({
        code: 'LEDGER_MISSING',
        severity: 'error',
        project: project.name,
        path: defaultDbPath,
        message: 'Ledger database not found at default path .memnant/ledger.db.',
        fixable: true,
        fix_description: 'Create ledger database with schema',
      });
    }
  }

  return findings;
}

/** Run all diagnostics across all registered projects. */
export function diagnoseAll(projectFilter?: string): DoctorReport {
  const findings: Finding[] = [];

  // Global checks
  findings.push(...diagnoseDist());
  findings.push(...diagnoseNpmLink());
  findings.push(...diagnoseMcpConfig());

  // Per-project checks
  const registry = loadRegistry();
  let projects = registry.projects;

  if (projectFilter) {
    projects = projects.filter(
      (p) => p.name.toLowerCase() === projectFilter.toLowerCase()
        || p.name.toLowerCase().startsWith(projectFilter.toLowerCase()),
    );
  }

  const projectsWithIssues = new Set<string>();

  for (const project of projects) {
    const projectFindings = diagnoseProject(project);
    findings.push(...projectFindings);
    if (projectFindings.length > 0) {
      projectsWithIssues.add(project.name);
    }
  }

  return {
    checked_at: new Date().toISOString(),
    memnant_version: VERSION,
    findings,
    projects_checked: projects.length,
    projects_healthy: projects.length - projectsWithIssues.size,
  };
}

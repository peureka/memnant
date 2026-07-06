/**
 * memnant doctor — Repair functions.
 *
 * Each function attempts to fix a specific finding.
 * Only called when --fix flag is passed.
 */

import { execFileSync } from 'child_process';
import { join } from 'path';
import { loadConfig } from '../config/load.js';
import { createDatabase } from '../ledger/database.js';
import { setupClaudeCode } from '../cli/setup.js';
import { loadRegistry, removeProject, saveRegistry } from '../registry/registry.js';
import type { Finding } from './types.js';
import { getPackageRoot } from './diagnose.js';

export interface RepairResult {
  code: string;
  success: boolean;
  message: string;
}

export function repairFinding(finding: Finding): RepairResult {
  if (!finding.fixable) {
    return { code: finding.code, success: false, message: 'Manual fix required' };
  }

  switch (finding.code) {
    case 'DIST_MISSING':
    case 'DIST_STALE':
      return repairDist();

    case 'LEDGER_MISSING':
      return repairLedger(finding);

    case 'MCP_ENTRY_MISSING':
      return repairMcpConfig();

    case 'PROJECT_DIR_MISSING':
      return repairRegistryEntry(finding);

    default:
      return { code: finding.code, success: false, message: 'No repair available' };
  }
}

function repairDist(): RepairResult {
  const root = getPackageRoot();
  try {
    execFileSync('npx', ['tsc'], { cwd: root, timeout: 60000, encoding: 'utf-8' });
    return { code: 'DIST_MISSING', success: true, message: 'Rebuilt dist/ via tsc' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'DIST_MISSING', success: false, message: `tsc failed: ${msg}` };
  }
}

function repairLedger(finding: Finding): RepairResult {
  if (!finding.project || !finding.path) {
    return { code: 'LEDGER_MISSING', success: false, message: 'No project path available' };
  }

  // Find the project root from registry
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.name === finding.project);
  if (!project) {
    return { code: 'LEDGER_MISSING', success: false, message: 'Project not found in registry' };
  }

  try {
    const config = loadConfig(project.root_path);
    const dbPath = join(project.root_path, config.memory.db_path);
    const db = createDatabase(dbPath);

    // Insert project row
    db.run(
      'INSERT OR IGNORE INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      [config.project.id, config.project.name, project.root_path, new Date().toISOString()],
    );
    db.close();

    return { code: 'LEDGER_MISSING', success: true, message: `Created ${config.memory.db_path}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'LEDGER_MISSING', success: false, message: `Failed to create database: ${msg}` };
  }
}

function repairMcpConfig(): RepairResult {
  try {
    setupClaudeCode();
    return { code: 'MCP_ENTRY_MISSING', success: true, message: 'Registered memnant in ~/.claude/mcp.json' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'MCP_ENTRY_MISSING', success: false, message: `Failed: ${msg}` };
  }
}

function repairRegistryEntry(finding: Finding): RepairResult {
  if (!finding.project) {
    return { code: 'PROJECT_DIR_MISSING', success: false, message: 'No project name' };
  }

  try {
    const registry = loadRegistry();
    removeProject(registry, finding.project);
    saveRegistry(undefined, registry);
    return { code: 'PROJECT_DIR_MISSING', success: true, message: `Removed ${finding.project} from registry` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 'PROJECT_DIR_MISSING', success: false, message: `Failed: ${msg}` };
  }
}

/** Attempt repairs on all fixable findings. */
export function repairAll(findings: Finding[]): RepairResult[] {
  const fixable = findings.filter((f) => f.fixable);
  // Deduplicate by code (e.g., only rebuild dist once)
  const seen = new Set<string>();
  const results: RepairResult[] = [];

  for (const finding of fixable) {
    const key = finding.code === 'LEDGER_MISSING' || finding.code === 'PROJECT_DIR_MISSING'
      ? `${finding.code}:${finding.project}`
      : finding.code;

    if (seen.has(key)) continue;
    seen.add(key);

    results.push(repairFinding(finding));
  }

  return results;
}

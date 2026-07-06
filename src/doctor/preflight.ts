/**
 * memnant doctor — Lightweight preflight check for MCP server startup.
 *
 * Runs a subset of diagnostics and emits warnings to stderr.
 * Does NOT block startup or attempt repairs.
 */

import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ProjectConfig } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] [preflight] ${message}\n`);
}

export function preflightCheck(projectRoot: string, config: ProjectConfig): void {
  // Check dist staleness
  const packageRoot = join(__dirname, '..', '..');
  const distEntry = join(packageRoot, 'dist', 'cli', 'index.js');
  const srcEntry = join(packageRoot, 'src', 'cli', 'index.ts');

  if (existsSync(srcEntry) && existsSync(distEntry)) {
    try {
      const srcMtime = statSync(srcEntry).mtimeMs;
      const distMtime = statSync(distEntry).mtimeMs;
      if (srcMtime > distMtime) {
        log('WARNING: dist/ is older than source. Run `memnant doctor --fix` or rebuild.');
      }
    } catch {
      // Non-critical, skip
    }
  }

  // Check ledger database
  const dbPath = join(projectRoot, config.memory.db_path);
  if (!existsSync(dbPath)) {
    log(`WARNING: Ledger database not found at ${config.memory.db_path}. Run \`memnant doctor --fix\` to recreate.`);
  }
}

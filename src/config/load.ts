/**
 * memnant — Config loader with validation.
 *
 * Replaces the scattered `yaml.load(readFileSync(...)) as ProjectConfig`
 * pattern with a single validated entry point.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import yaml from 'js-yaml';
import type { ProjectConfig } from '../types.js';

/**
 * Walk up from startDir to find the nearest directory containing memnant.yaml.
 * Returns the directory path, or null if not found.
 */
export function findProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'memnant.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load and validate memnant.yaml from the given directory.
 *
 * Checks:
 * - File exists
 * - YAML parses without error
 * - Required fields present: project.id, project.name, memory.db_path
 *
 * @throws ConfigError with a specific, actionable message
 */
export function loadConfig(cwd: string): ProjectConfig {
  const configPath = join(cwd, 'memnant.yaml');

  if (!existsSync(configPath)) {
    throw new ConfigError('No memnant project found. Run `memnant init` first.');
  }

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to parse memnant.yaml: ${detail}`);
  }

  // Validate structure
  const config = raw as Record<string, unknown> | undefined | null;

  const missing: string[] = [];

  if (!config || typeof config !== 'object') {
    missing.push('project.id', 'project.name', 'memory.db_path');
  } else {
    const project = config.project as Record<string, unknown> | undefined;
    if (!project || typeof project !== 'object') {
      missing.push('project.id', 'project.name');
    } else {
      if (!project.id) missing.push('project.id');
      if (!project.name) missing.push('project.name');
    }

    const memory = config.memory as Record<string, unknown> | undefined;
    if (!memory || typeof memory !== 'object') {
      missing.push('memory.db_path');
    } else {
      if (!memory.db_path) missing.push('memory.db_path');
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `Invalid memnant.yaml: missing required field(s): ${missing.join(', ')}. Check your config or run \`memnant init\` to regenerate.`,
    );
  }

  return raw as ProjectConfig;
}

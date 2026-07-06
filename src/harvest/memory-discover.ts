/**
 * memnant — Claude Code memory directory discovery.
 *
 * Discovers memory directories and maps them to memnant projects.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadRegistry, type RegistryProject } from '../registry/registry.js';

export interface MemorySource {
  memoryDir: string;
  projectSlug: string;
  registryProject: RegistryProject | null;
}

/**
 * Discover Claude Code memory directories that match registered memnant projects.
 *
 * Strategy: iterate registry projects, compute their Claude Code slug,
 * check if a memory directory exists for that slug.
 */
export function discoverMemorySources(): MemorySource[] {
  const registry = loadRegistry();
  const sources: MemorySource[] = [];
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  if (!existsSync(claudeProjectsDir)) return [];

  for (const project of registry.projects) {
    const slug = projectRootToSlug(project.root_path);
    const memoryDir = join(claudeProjectsDir, slug, 'memory');

    if (existsSync(memoryDir)) {
      sources.push({
        memoryDir,
        projectSlug: slug,
        registryProject: project,
      });
    }
  }

  // Also check for workspace-level memory dirs (e.g., parent directories)
  // These are common when Claude Code is opened at a parent directory
  try {
    const allSlugs = readdirSync(claudeProjectsDir);
    const registrySlugs = new Set(registry.projects.map((p) => projectRootToSlug(p.root_path)));

    for (const slug of allSlugs) {
      if (registrySlugs.has(slug)) continue; // Already matched
      const memoryDir = join(claudeProjectsDir, slug, 'memory');
      if (existsSync(memoryDir)) {
        sources.push({
          memoryDir,
          projectSlug: slug,
          registryProject: null, // Workspace-level, no single project match
        });
      }
    }
  } catch {
    // Non-critical
  }

  return sources;
}

/** Convert a project root path to a Claude Code slug. */
export function projectRootToSlug(projectRoot: string): string {
  return projectRoot.replace(/\//g, '-');
}

/** List all .md files in a memory directory. */
export function listMemoryFiles(memoryDir: string): string[] {
  try {
    return readdirSync(memoryDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(memoryDir, f));
  } catch {
    return [];
  }
}

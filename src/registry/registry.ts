/**
 * memnant — Machine-local project registry.
 *
 * Tracks all memnant projects on this machine for federated search and team sync.
 * Stored at ~/.memnant/registry.json. Optional — all existing functionality
 * works without it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface RegistryProject {
  id: string;
  name: string;
  root_path: string;
  added_at: string;
  last_accessed?: string;
}

export interface Workspace {
  name: string;
  projects: string[];
  created_at: string;
}

export interface Registry {
  projects: RegistryProject[];
  workspaces?: Workspace[];
}

/**
 * Get the default registry path (~/.memnant/registry.json).
 */
export function getRegistryPath(): string {
  return join(homedir(), '.memnant', 'registry.json');
}

/**
 * Load the registry from disk. Returns empty registry if file doesn't exist.
 */
export function loadRegistry(registryPath?: string): Registry {
  const path = registryPath ?? getRegistryPath();

  if (!existsSync(path)) {
    return { projects: [] };
  }

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return { projects: data.projects ?? [], workspaces: data.workspaces };
  } catch {
    return { projects: [] };
  }
}

/**
 * Save the registry to disk.
 */
export function saveRegistry(registryPath: string | undefined, registry: Registry): void {
  const path = registryPath ?? getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
}

/**
 * Add a project to the registry. Skips if project ID already exists.
 */
export function addProject(
  registry: Registry,
  project: { id: string; name: string; root_path: string },
): boolean {
  if (registry.projects.some((p) => p.id === project.id)) {
    return false;
  }

  const now = new Date().toISOString();
  registry.projects.push({
    ...project,
    added_at: now,
    last_accessed: now,
  });
  return true;
}

/**
 * Remove a project by name. Returns true if found and removed.
 */
export function removeProject(registry: Registry, name: string): boolean {
  const idx = registry.projects.findIndex((p) => p.name === name);
  if (idx === -1) return false;
  registry.projects.splice(idx, 1);
  return true;
}

/**
 * Update last_accessed timestamp for a project.
 */
export function touchProject(registry: Registry, id: string): void {
  const project = registry.projects.find((p) => p.id === id);
  if (project) {
    project.last_accessed = new Date().toISOString();
  }
}

/**
 * Find a project by name (case-insensitive prefix match).
 */
export function findProject(registry: Registry, name: string): RegistryProject | undefined {
  const lower = name.toLowerCase();
  return registry.projects.find((p) => p.name.toLowerCase() === lower)
    ?? registry.projects.find((p) => p.name.toLowerCase().startsWith(lower));
}

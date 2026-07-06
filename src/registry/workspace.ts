/**
 * memnant — Workspace resolution.
 *
 * Resolves sibling projects for the current project based on workspace config.
 * Looks up workspace membership from the registry, or falls back to memnant.yaml config.
 */

import { loadRegistry, type Registry, type Workspace } from './registry.js';
import { resolveProjects, type FederatedProject } from './federated-search.js';
import type { ProjectConfig } from '../types.js';

export type { Workspace };

export interface WorkspaceInfo {
  name: string;
  siblings: FederatedProject[];
}

/** Get workspace for a project from registry. */
export function getWorkspaceForProject(registry: Registry, projectName: string): Workspace | undefined {
  if (!registry.workspaces) return undefined;
  return registry.workspaces.find((w) =>
    w.projects.some((p) => p.toLowerCase() === projectName.toLowerCase()),
  );
}

/** Add a workspace to the registry. Returns false if name already exists. */
export function addWorkspace(registry: Registry, name: string, projectNames: string[]): boolean {
  if (!registry.workspaces) {
    registry.workspaces = [];
  }
  if (registry.workspaces.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
    return false;
  }
  registry.workspaces.push({
    name,
    projects: projectNames,
    created_at: new Date().toISOString(),
  });
  return true;
}

/** Remove a workspace by name. Returns true if found and removed. */
export function removeWorkspace(registry: Registry, name: string): boolean {
  if (!registry.workspaces) return false;
  const idx = registry.workspaces.findIndex((w) => w.name.toLowerCase() === name.toLowerCase());
  if (idx === -1) return false;
  registry.workspaces.splice(idx, 1);
  return true;
}

/**
 * Resolve workspace for the current project.
 *
 * 1. Check config.workspace.name for workspace name
 * 2. If not in config, check registry for workspace membership
 * 3. Resolve sibling project names to FederatedProject[] (excluding current project)
 */
export function resolveWorkspace(
  projectName: string,
  config: ProjectConfig,
): WorkspaceInfo | null {
  const registry = loadRegistry() as Registry;

  // Find workspace: from config first, then from registry
  let workspace: Workspace | undefined;

  const configWorkspaceName = (config as any).workspace?.name as string | undefined;
  if (configWorkspaceName) {
    workspace = registry.workspaces?.find((w) => w.name.toLowerCase() === configWorkspaceName.toLowerCase());
  }

  if (!workspace) {
    workspace = getWorkspaceForProject(registry, projectName);
  }

  if (!workspace) return null;

  // Resolve sibling names to FederatedProject[], excluding current project
  const siblingNames = workspace.projects.filter(
    (p) => p.toLowerCase() !== projectName.toLowerCase(),
  );

  if (siblingNames.length === 0) return null;

  const siblings = resolveProjects(siblingNames, registry.projects);

  if (siblings.length === 0) return null;

  return {
    name: workspace.name,
    siblings,
  };
}

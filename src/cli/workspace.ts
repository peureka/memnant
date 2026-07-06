/**
 * memnant workspace — Manage product workspaces.
 *
 * Groups related repos so they share context during sessions.
 */

import { Command } from 'commander';

export function registerWorkspaceCommand(program: Command): void {
  const cmd = program
    .command('workspace')
    .description('Manage product workspaces (group related repos)');

  cmd
    .command('add')
    .description('Create a workspace grouping related projects')
    .argument('<name>', 'Workspace name (e.g. "lineconic")')
    .requiredOption('--projects <names>', 'Comma-separated project names')
    .action(async (name: string, opts: { projects: string }) => {
      const { loadRegistry, saveRegistry, findProject } = await import('../registry/registry.js');
      const { addWorkspace } = await import('../registry/workspace.js');

      const registry = loadRegistry();
      const projectNames = opts.projects.split(',').map((s) => s.trim());

      // Validate all projects exist in registry
      const missing: string[] = [];
      for (const pName of projectNames) {
        if (!findProject(registry, pName)) {
          missing.push(pName);
        }
      }

      if (missing.length > 0) {
        console.error(`Projects not found in registry: ${missing.join(', ')}`);
        console.error('Run `memnant projects` to see registered projects.');
        process.exit(1);
      }

      const added = addWorkspace(registry, name, projectNames);
      if (!added) {
        console.error(`Workspace "${name}" already exists. Remove it first with \`memnant workspace remove ${name}\`.`);
        process.exit(1);
      }

      saveRegistry(undefined, registry);
      console.log(`Created workspace "${name}" with ${projectNames.length} projects: ${projectNames.join(', ')}`);
    });

  cmd
    .command('remove')
    .description('Remove a workspace (does not affect projects)')
    .argument('<name>', 'Workspace name')
    .action(async (name: string) => {
      const { loadRegistry, saveRegistry } = await import('../registry/registry.js');
      const { removeWorkspace } = await import('../registry/workspace.js');

      const registry = loadRegistry();
      const removed = removeWorkspace(registry, name);

      if (!removed) {
        console.error(`Workspace "${name}" not found.`);
        process.exit(1);
      }

      saveRegistry(undefined, registry);
      console.log(`Removed workspace "${name}".`);
    });

  cmd
    .command('list')
    .description('List all workspaces')
    .action(async () => {
      const { loadRegistry } = await import('../registry/registry.js');
      const registry = loadRegistry();

      const workspaces = registry.workspaces ?? [];
      if (workspaces.length === 0) {
        console.log('No workspaces configured.');
        console.log('Create one: memnant workspace add <name> --projects p1,p2,p3');
        return;
      }

      for (const w of workspaces) {
        console.log(`${w.name}: ${w.projects.join(', ')}`);
      }
    });
}

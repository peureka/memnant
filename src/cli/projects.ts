/**
 * memnant projects — List, add, and remove projects from the machine registry.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerProjectsCommand(program: Command): void {
  const cmd = program
    .command('projects')
    .description('Manage the machine-local project registry');

  cmd
    .command('list')
    .description('List all registered memnant projects')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const { loadRegistry } = await import('../registry/registry.js');

      const reg = loadRegistry();

      if (opts.json) {
        console.log(JSON.stringify(reg.projects, null, 2));
        return;
      }

      if (reg.projects.length === 0) {
        console.log('No projects registered. Run `memnant init` in a project directory or `memnant projects add <path>`.');
        return;
      }

      for (const p of reg.projects) {
        const exists = existsSync(join(p.root_path, 'memnant.yaml')) ? '' : ' (missing)';
        const accessed = p.last_accessed ? `  (last: ${p.last_accessed.slice(0, 10)})` : '';
        console.log(`${p.name}  ${p.root_path}${exists}${accessed}`);
      }
    });

  cmd
    .command('add')
    .description('Register an existing memnant project')
    .argument('<path>', 'Path to the project root (must contain memnant.yaml)')
    .action(async (path: string) => {
      const { loadRegistry, saveRegistry, addProject } = await import('../registry/registry.js');
      const { loadConfig, ConfigError } = await import('../config/load.js');

      let config;
      try {
        config = loadConfig(path);
      } catch (err) {
        console.error(err instanceof ConfigError ? err.message : String(err));
        process.exit(1);
      }

      const reg = loadRegistry();
      const added = addProject(reg, {
        id: config.project.id,
        name: config.project.name,
        root_path: path,
      });

      if (!added) {
        console.log(`Project "${config.project.name}" is already registered.`);
        return;
      }

      saveRegistry(undefined, reg);
      console.log(`Registered "${config.project.name}" at ${path}`);
    });

  cmd
    .command('remove')
    .description('Unregister a project (does not delete any data)')
    .argument('<name>', 'Project name to remove')
    .action(async (name: string) => {
      const { loadRegistry, saveRegistry, removeProject } = await import('../registry/registry.js');

      const reg = loadRegistry();
      const removed = removeProject(reg, name);

      if (!removed) {
        console.error(`No project named "${name}" in registry.`);
        process.exit(1);
      }

      saveRegistry(undefined, reg);
      console.log(`Removed "${name}" from registry.`);
    });

  // Default action: list
  cmd.action(async () => {
    const { loadRegistry } = await import('../registry/registry.js');

    const reg = loadRegistry();
    if (reg.projects.length === 0) {
      console.log('No projects registered. Run `memnant init` in a project directory.');
      return;
    }
    for (const p of reg.projects) {
      const exists = existsSync(join(p.root_path, 'memnant.yaml')) ? '' : ' (missing)';
      const accessed = p.last_accessed ? `  (last: ${p.last_accessed.slice(0, 10)})` : '';
      console.log(`${p.name}  ${p.root_path}${exists}${accessed}`);
    }
  });
}

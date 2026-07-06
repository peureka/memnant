/**
 * memnant check-design — Design system validation command.
 *
 * Story 5.3: Scans source files for banned components from the design system spec.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { DesignViolation } from '../governor/design-check.js';

export function registerCheckDesignCommand(program: Command): void {
  program
    .command('check-design')
    .description('Check source files for banned components from the design system spec')
    .argument('<path>', 'File or directory to check')
    .action(async (targetPath: string) => {
      const { checkDesign } = await import('../governor/design-check.js');
      const { scanSpecs } = await import('../governor/specs.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
        process.exit(1);
      }

      let config;
      try {
        config = loadConfig(projectRoot);
      } catch (err) {
        console.error(err instanceof ConfigError ? err.message : String(err));
        process.exit(1);
      }

      const docsPath = join(projectRoot, config.governor.docs_path);

      // Check if design system spec exists
      const specs = scanSpecs(docsPath);
      const designSpec = specs.find((s) => s.frontmatter.type === 'design_system');
      if (!designSpec) {
        console.log(`No design system spec found in ${config.governor.docs_path}. Create one with type: design_system frontmatter.`);
        return;
      }

      const absPath = join(projectRoot, targetPath);
      if (!existsSync(absPath)) {
        console.error(`Path not found: ${targetPath}`);
        process.exit(1);
      }

      const allViolations: DesignViolation[] = [];

      const stat = statSync(absPath);
      if (stat.isFile()) {
        const code = readFileSync(absPath, 'utf-8');
        const result = checkDesign(code, targetPath, docsPath);
        allViolations.push(...result.violations);
      } else if (stat.isDirectory()) {
        const files = collectSourceFiles(absPath);
        for (const file of files) {
          const relPath = relative(projectRoot, file);
          const code = readFileSync(file, 'utf-8');
          const result = checkDesign(code, relPath, docsPath);
          allViolations.push(...result.violations);
        }
      }

      if (allViolations.length === 0) {
        console.log('No design system violations found.');
        return;
      }

      for (const v of allViolations) {
        console.log(`${v.file}:${v.line} ${v.message}`);
      }

      process.exit(1);
    });
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
  '.html', '.css', '.scss',
]);

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', '.memnant', 'dist', '.next']);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (skipDirs.has(entry)) continue;
    const absPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...collectSourceFiles(absPath));
    } else if (stat.isFile()) {
      const ext = entry.slice(entry.lastIndexOf('.'));
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push(absPath);
      }
    }
  }

  return results;
}

/**
 * memnant lint — CI integration for spec checks.
 *
 * Story 5.5: Runs all applicable spec checks (copy audit, design system
 * validation) on source files. Designed for CI pipelines and pre-commit hooks.
 *
 * Story 14.2: --staged flag for pre-commit hook integration.
 * Story 14.3: --force logs governance_override records.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';
import type { CopyViolation } from '../governor/copy-check.js';
import type { DesignViolation } from '../governor/design-check.js';

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
  '.html', '.css', '.scss',
]);

const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.md', '.mdx', '.txt', '.yaml', '.yml', '.json',
]);

/**
 * Get staged file paths from git.
 */
function getStagedFiles(cwd: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], {
      cwd,
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('Run all spec checks (copy audit, design system) for CI')
    .argument('[path]', 'File or directory to lint (default: current directory)', '.')
    .option('--strict', 'Treat discouraged violations as errors')
    .option('--staged', 'Lint only git-staged files (for pre-commit hooks)')
    .option('--force', 'Exit 0 even with violations and log overrides to the ledger')
    .option('--plugin <name>', 'Run only a specific plugin')
    .action(async (targetPath: string, opts: { strict?: boolean; staged?: boolean; force?: boolean; plugin?: string }) => {
      const { checkCopy } = await import('../governor/copy-check.js');
      const { checkDesign } = await import('../governor/design-check.js');
      const { scanSpecs, extractSpecDetail } = await import('../governor/specs.js');
      const { loadPlugins, runPlugins } = await import('../governor/plugins.js');
      const { openDatabase } = await import('../ledger/database.js');
      const { insertRecord } = await import('../ledger/records.js');
      const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');
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

      // Check if any spec documents exist
      const specs = scanSpecs(docsPath);
      let plugins = await loadPlugins(config.governor.plugins, projectRoot);
      if (opts.plugin) {
        plugins = plugins.filter((p) => p.name === opts.plugin);
      }

      if (specs.length === 0 && plugins.length === 0) {
        console.log('No spec documents found. Nothing to lint.');
        return;
      }

      const hasCopySpec = specs.some((s) => s.frontmatter.type === 'copy_audit');
      const hasDesignSpec = specs.some((s) => s.frontmatter.type === 'design_system');

      if (!hasCopySpec && !hasDesignSpec && plugins.length === 0) {
        console.log('No spec documents found. Nothing to lint.');
        return;
      }

      // Determine files to lint
      let files: string[];
      if (opts.staged) {
        const stagedPaths = getStagedFiles(projectRoot);
        if (stagedPaths.length === 0) {
          console.log('No staged files to lint.');
          return;
        }
        files = stagedPaths.map((p) => join(projectRoot, p)).filter((f) => existsSync(f));
      } else {
        const absPath = join(projectRoot, targetPath);
        if (!existsSync(absPath)) {
          console.error(`Path not found: ${targetPath}`);
          process.exit(1);
        }
        files = collectFiles(absPath);
      }

      let bannedCount = 0;
      let discouragedCount = 0;
      let totalViolations = 0;
      const violationMessages: string[] = [];

      for (const file of files) {
        const relPath = relative(projectRoot, file);
        const ext = file.slice(file.lastIndexOf('.'));
        let content: string;
        try {
          content = readFileSync(file, 'utf-8');
        } catch {
          continue;
        }

        // Run copy audit on text files
        if (hasCopySpec && TEXT_EXTENSIONS.has(ext)) {
          const result = checkCopy(content, docsPath);
          for (const v of result.violations) {
            totalViolations++;
            if (v.level === 'banned') bannedCount++;
            if (v.level === 'discouraged') discouragedCount++;
            const lineRef = v.line ? `:${v.line}` : '';
            const msg = `${relPath}${lineRef} ${v.message}`;
            console.log(msg);
            violationMessages.push(msg);
          }
        }

        // Run design system check on source files
        if (hasDesignSpec && SOURCE_EXTENSIONS.has(ext)) {
          const result = checkDesign(content, relPath, docsPath);
          for (const v of result.violations) {
            totalViolations++;
            bannedCount++;
            const msg = `${v.file}:${v.line} ${v.message}`;
            console.log(msg);
            violationMessages.push(msg);
          }
        }

        // Run plugins
        if (plugins.length > 0) {
          for (const spec of specs) {
            const detail = extractSpecDetail(spec);
            const pluginViolations = runPlugins(plugins, content, { ...detail, type: spec.frontmatter.type });
            for (const v of pluginViolations) {
              totalViolations++;
              if (v.severity === 'banned') bannedCount++;
              if (v.severity === 'discouraged') discouragedCount++;
              const lineRef = v.line ? `:${v.line}` : '';
              const msg = `${relPath}${lineRef} ${v.message}`;
              console.log(msg);
              violationMessages.push(msg);
            }
          }
        }
      }

      if (totalViolations === 0) {
        console.log('All checks passed.');
        return;
      }

      console.log('');
      console.log(`${totalViolations} violation(s): ${bannedCount} banned, ${discouragedCount} discouraged`);

      // Story 14.3: --force logs overrides and exits 0
      if (opts.force) {
        console.log('--force: overriding violations.');
        const dbPath = join(projectRoot, config.memory.db_path);
        if (existsSync(dbPath)) {
          const db = openDatabase(dbPath);
          try {
            for (const msg of violationMessages) {
              const embedding = await generateEmbedding(msg);
              insertRecord(db, {
                projectId: config.project.id,
                type: 'governance_override',
                contentText: msg,
                tags: ['override', 'lint'],
                embedding: serializeEmbedding(embedding),
              });
            }
            console.log(`Logged ${violationMessages.length} governance override(s) to the ledger.`);
          } finally {
            db.close();
          }
        }
        return; // Exit 0
      }

      if (bannedCount > 0) {
        process.exit(1);
      }

      if (opts.strict && discouragedCount > 0) {
        process.exit(1);
      }
    });
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.memnant', 'dist', '.next']);

function collectFiles(target: string): string[] {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    const ext = target.slice(target.lastIndexOf('.'));
    if (TEXT_EXTENSIONS.has(ext)) return [target];
    return [];
  }

  if (!stat.isDirectory()) return [];

  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const absPath = join(target, entry);
    results.push(...collectFiles(absPath));
  }

  return results;
}

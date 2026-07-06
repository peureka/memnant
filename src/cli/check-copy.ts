/**
 * memnant check-copy — Copy audit check command.
 *
 * Story 5.2: Checks text against copy audit rules.
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function registerCheckCopyCommand(program: Command): void {
  program
    .command('check-copy')
    .description('Check text against the copy audit spec')
    .argument('[text]', 'Text to check (or use --file)')
    .option('--file <path>', 'Check an entire file')
    .action(async (text: string | undefined, opts: { file?: string }) => {
      const { checkCopy } = await import('../governor/copy-check.js');
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

      // Check if copy audit spec exists
      const specs = scanSpecs(docsPath);
      const copySpec = specs.find((s) => s.frontmatter.type === 'copy_audit');
      if (!copySpec) {
        console.log(`No copy audit spec found in ${config.governor.docs_path}. Create one with type: copy_audit frontmatter.`);
        return;
      }

      // Get text to check
      let content: string;
      if (opts.file) {
        const filePath = join(projectRoot, opts.file);
        if (!existsSync(filePath)) {
          console.error(`File not found: ${opts.file}`);
          process.exit(1);
        }
        content = readFileSync(filePath, 'utf-8');
      } else if (text) {
        content = text;
      } else if (!process.stdin.isTTY) {
        content = readFileSync(0, 'utf-8');
      } else {
        console.error('Provide text as an argument, via --file, or pipe from stdin.');
        process.exit(1);
      }

      const result = checkCopy(content, docsPath);

      if (result.violations.length === 0) {
        console.log('No copy violations found.');
        return;
      }

      for (const v of result.violations) {
        const lineInfo = v.line ? `:${v.line}` : '';
        const prefix = opts.file ? `${opts.file}${lineInfo} ` : '';
        console.log(`${prefix}${v.message}`);
      }

      if (result.hasBanned) {
        process.exit(1);
      }
    });
}

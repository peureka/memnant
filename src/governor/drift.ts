/**
 * memnant — Spec drift detection.
 *
 * Story 13.3: During snapshot, run governor checks on changed files.
 * Flag new violations as spec drift.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkCopy, type CopyViolation } from './copy-check.js';
import { checkDesign, type DesignViolation } from './design-check.js';
import { scanSpecs } from './specs.js';

export interface DriftResult {
  copy_violations: Array<{ file: string; violations: CopyViolation[] }>;
  design_violations: Array<{ file: string; violations: DesignViolation[] }>;
  total_violations: number;
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte',
  '.html', '.css', '.scss',
]);

const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.md', '.mdx', '.txt', '.yaml', '.yml', '.json',
]);

/**
 * Detect spec drift in changed files.
 * Takes a list of changed file paths (relative to project root) and runs
 * copy audit + design system checks against them.
 */
export function detectSpecDrift(
  changedFiles: string[],
  projectRoot: string,
  docsPath: string,
): DriftResult {
  const specs = scanSpecs(docsPath);
  if (specs.length === 0) {
    return { copy_violations: [], design_violations: [], total_violations: 0 };
  }

  const hasCopySpec = specs.some((s) => s.frontmatter.type === 'copy_audit');
  const hasDesignSpec = specs.some((s) => s.frontmatter.type === 'design_system');

  const copyViolations: Array<{ file: string; violations: CopyViolation[] }> = [];
  const designViolations: Array<{ file: string; violations: DesignViolation[] }> = [];
  let totalViolations = 0;

  for (const relPath of changedFiles) {
    const absPath = join(projectRoot, relPath);
    if (!existsSync(absPath)) continue;

    const ext = relPath.slice(relPath.lastIndexOf('.'));
    let content: string;
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Copy audit on text files
    if (hasCopySpec && TEXT_EXTENSIONS.has(ext)) {
      const result = checkCopy(content, docsPath);
      if (result.violations.length > 0) {
        copyViolations.push({ file: relPath, violations: result.violations });
        totalViolations += result.violations.length;
      }
    }

    // Design system check on source files
    if (hasDesignSpec && SOURCE_EXTENSIONS.has(ext)) {
      const result = checkDesign(content, relPath, docsPath);
      if (result.violations.length > 0) {
        designViolations.push({ file: relPath, violations: result.violations });
        totalViolations += result.violations.length;
      }
    }
  }

  return { copy_violations: copyViolations, design_violations: designViolations, total_violations: totalViolations };
}

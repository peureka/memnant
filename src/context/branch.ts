/**
 * memnant — Branch-aware context.
 *
 * Story 12.2: Read .git/HEAD to detect current branch, fuzzy match to epic.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Detect the current git branch from .git/HEAD.
 * Returns null if not in a git repo or HEAD is detached.
 */
export function detectBranch(projectRoot: string): string | null {
  const headPath = join(projectRoot, '.git', 'HEAD');
  if (!existsSync(headPath)) return null;

  const content = readFileSync(headPath, 'utf-8').trim();

  // ref: refs/heads/branch-name
  const match = content.match(/^ref: refs\/heads\/(.+)$/);
  return match ? match[1] : null;
}

/**
 * Extract an epic name from a branch name.
 *
 * Pattern matching:
 *   epic-12           → "Epic 12"
 *   e12               → "Epic 12"
 *   12.1-file-context → "Epic 12"
 *   feature/epic-12   → "Epic 12"
 *   main/master/develop → null (no scoping)
 */
export function branchToEpic(branchName: string | null): string | null {
  if (!branchName) return null;

  // Skip main branches — no epic scoping
  const mainBranches = ['main', 'master', 'develop', 'dev', 'staging', 'production'];
  if (mainBranches.includes(branchName.toLowerCase())) return null;

  // Extract the relevant part (after last /)
  const parts = branchName.split('/');
  const name = parts[parts.length - 1];

  // Match: epic-12, e12, epic12
  const epicMatch = name.match(/^e(?:pic)?[-_]?(\d+)/i);
  if (epicMatch) return `Epic ${epicMatch[1]}`;

  // Match: 12.1-description or 12-description
  const numericMatch = name.match(/^(\d+)[\.\-]/);
  if (numericMatch) return `Epic ${numericMatch[1]}`;

  return null;
}

/**
 * Auto-detect epic from the current branch.
 * Returns null if on main or branch doesn't match any epic pattern.
 */
export function autoDetectEpic(projectRoot: string): string | null {
  const branch = detectBranch(projectRoot);
  return branchToEpic(branch);
}

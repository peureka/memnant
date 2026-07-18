/**
 * memnant — Branch-aware context.
 *
 * Story 12.2: Read .git/HEAD to detect current branch, fuzzy match to epic.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';

/**
 * Detect the current git branch from .git/HEAD.
 * Returns null if not in a git repo or HEAD is detached.
 *
 * Handles git worktrees, where `<projectRoot>/.git` is a FILE containing
 * `gitdir: <path>` pointing at `<main>/.git/worktrees/<name>`; HEAD lives
 * inside that pointed-to directory. Pure-fs, no child processes — this runs
 * on every context compile.
 */
export function detectBranch(projectRoot: string): string | null {
  const gitPath = join(projectRoot, '.git');
  if (!existsSync(gitPath)) return null;

  let gitDir: string;
  try {
    if (statSync(gitPath).isDirectory()) {
      gitDir = gitPath;
    } else {
      // Worktree: .git is a file `gitdir: <abs-or-relative-path>`
      const pointer = readFileSync(gitPath, 'utf-8').trim();
      const gitdirMatch = pointer.match(/^gitdir:\s*(.+)$/m);
      if (!gitdirMatch) return null;
      const target = gitdirMatch[1].trim();
      gitDir = isAbsolute(target) ? target : join(projectRoot, target);
    }
  } catch {
    return null;
  }

  const headPath = join(gitDir, 'HEAD');
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

/**
 * memnant — Codebase snapshot scanner.
 *
 * Story 3.1: Scans the project file tree, computes hashes, reads
 * package.json dependencies. Respects .gitignore and .memnantignore.
 * Uses `git ls-files` in git repos for correctness, falls back to
 * manual walk with ignore patterns.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { Database } from '../ledger/database.js';

export interface FileEntry {
  path: string;
  hash: string;
}

export interface SnapshotData {
  files: FileEntry[];
  dependencies: Record<string, string> | null;
  file_count: number;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  modified: string[];
  dep_added: string[];
  dep_removed: string[];
  dep_changed: Array<{ name: string; from: string; to: string }>;
}

/**
 * Scan the project root and produce a SnapshotData.
 */
export function scanProject(projectRoot: string): SnapshotData {
  const filePaths = listProjectFiles(projectRoot);
  const files: FileEntry[] = [];

  for (const relPath of filePaths) {
    const absPath = join(projectRoot, relPath);
    try {
      const content = readFileSync(absPath);
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      files.push({ path: relPath, hash });
    } catch {
      // Skip files we can't read (permissions, etc.)
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  const dependencies = readDependencies(projectRoot);

  return {
    files,
    dependencies,
    file_count: files.length,
  };
}

/**
 * List project files respecting .gitignore and .memnantignore.
 */
function listProjectFiles(projectRoot: string): string[] {
  const isGitRepo = existsSync(join(projectRoot, '.git'));

  let filePaths: string[];
  if (isGitRepo) {
    filePaths = listViaGit(projectRoot);
  } else {
    filePaths = walkDirectory(projectRoot, projectRoot);
  }

  // Apply .memnantignore if it exists
  const memnantIgnorePath = join(projectRoot, '.memnantignore');
  if (existsSync(memnantIgnorePath)) {
    const patterns = readFileSync(memnantIgnorePath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    filePaths = filePaths.filter((p) => !matchesAnyPattern(p, patterns));
  }

  return filePaths;
}

function listViaGit(projectRoot: string): string[] {
  try {
    const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    // Fallback to manual walk if git command fails
    return walkDirectory(projectRoot, projectRoot);
  }
}

function walkDirectory(dir: string, root: string): string[] {
  const results: string[] = [];
  const skipDirs = new Set(['node_modules', '.git', '.memnant', 'dist', '.next', '__pycache__']);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (skipDirs.has(entry)) continue;
    if (entry.startsWith('.') && entry !== '.memnantignore') continue;

    const absPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...walkDirectory(absPath, root));
    } else if (stat.isFile()) {
      results.push(relative(root, absPath));
    }
  }

  return results;
}

/**
 * Simple glob-like pattern matching for .memnantignore.
 * Supports: *.ext, dir/, dir/*, exact match.
 */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      // Directory pattern: matches anything under that directory
      if (filePath.startsWith(pattern) || filePath.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    } else if (pattern.startsWith('*.')) {
      // Extension pattern
      if (filePath.endsWith(pattern.slice(1))) {
        return true;
      }
    } else if (pattern.includes('*')) {
      // Simple wildcard
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(filePath)) {
        return true;
      }
    } else {
      // Exact match or prefix match
      if (filePath === pattern || filePath.startsWith(pattern + '/')) {
        return true;
      }
    }
  }
  return false;
}

function readDependencies(projectRoot: string): Record<string, string> | null {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (e: any) {
    console.error(`Failed to parse ${pkgPath}:`, e?.message);
    return null;
  }

  const deps: Record<string, string> = {};
  if (pkg.dependencies) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      deps[name] = version as string;
    }
  }
  if (pkg.devDependencies) {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      deps[name] = version as string;
    }
  }
  return deps;
}

/**
 * Diff two snapshots.
 */
export function diffSnapshots(
  oldSnapshot: SnapshotData | null,
  newSnapshot: SnapshotData,
): SnapshotDiff {
  if (!oldSnapshot) {
    return {
      added: newSnapshot.files.map((f) => f.path),
      removed: [],
      modified: [],
      dep_added: Object.keys(newSnapshot.dependencies ?? {}),
      dep_removed: [],
      dep_changed: [],
    };
  }

  const oldMap = new Map(oldSnapshot.files.map((f) => [f.path, f.hash]));
  const newMap = new Map(newSnapshot.files.map((f) => [f.path, f.hash]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [path, hash] of newMap) {
    const oldHash = oldMap.get(path);
    if (!oldHash) {
      added.push(path);
    } else if (oldHash !== hash) {
      modified.push(path);
    }
  }

  for (const path of oldMap.keys()) {
    if (!newMap.has(path)) {
      removed.push(path);
    }
  }

  // Dependency diff
  const oldDeps = oldSnapshot.dependencies ?? {};
  const newDeps = newSnapshot.dependencies ?? {};
  const depAdded: string[] = [];
  const depRemoved: string[] = [];
  const depChanged: Array<{ name: string; from: string; to: string }> = [];

  for (const name of Object.keys(newDeps)) {
    if (!(name in oldDeps)) {
      depAdded.push(name);
    } else if (oldDeps[name] !== newDeps[name]) {
      depChanged.push({ name, from: oldDeps[name], to: newDeps[name] });
    }
  }
  for (const name of Object.keys(oldDeps)) {
    if (!(name in newDeps)) {
      depRemoved.push(name);
    }
  }

  return { added, removed, modified, dep_added: depAdded, dep_removed: depRemoved, dep_changed: depChanged };
}

/**
 * Build human-readable summary text from a diff.
 */
export function buildSummaryText(data: SnapshotData, diff: SnapshotDiff): string {
  const changedCount = diff.added.length + diff.removed.length + diff.modified.length;
  const keyChanges: string[] = [];

  if (diff.modified.length > 0) {
    keyChanges.push(...diff.modified.slice(0, 5));
  }
  if (diff.added.length > 0) {
    keyChanges.push(...diff.added.slice(0, 3).map((p) => `+${p}`));
  }
  if (diff.removed.length > 0) {
    keyChanges.push(...diff.removed.slice(0, 3).map((p) => `-${p}`));
  }

  let text = `${data.file_count} files, ${changedCount} changed since last snapshot`;
  if (keyChanges.length > 0) {
    text += `, key changes: ${keyChanges.join(', ')}`;
  }
  return text;
}

/**
 * Get the most recent codebase snapshot from the DB.
 */
export function getLastSnapshot(db: Database): SnapshotData | null {
  const row = db.get(
    `SELECT content FROM record WHERE type = 'codebase_snapshot' ORDER BY created_at DESC LIMIT 1`,
  ) as unknown as { content: string } | undefined;

  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content);
    return parsed as SnapshotData;
  } catch {
    return null;
  }
}

/**
 * Get the creation date of the most recent snapshot.
 */
export function getLastSnapshotDate(db: Database): string | null {
  const row = db.get(
    `SELECT created_at FROM record WHERE type = 'codebase_snapshot' ORDER BY created_at DESC LIMIT 1`,
  ) as unknown as { created_at: string } | undefined;

  return row?.created_at ?? null;
}

/**
 * Get all changed file paths from the diff (added + modified + removed).
 */
export function getChangedPaths(diff: SnapshotDiff): string[] {
  return [...diff.added, ...diff.modified, ...diff.removed];
}

/**
 * Get changed dependency names from the diff.
 */
export function getChangedDeps(diff: SnapshotDiff): string[] {
  return [
    ...diff.dep_added,
    ...diff.dep_removed,
    ...diff.dep_changed.map((d) => d.name),
  ];
}

/**
 * Delete old snapshots beyond the max count.
 */
export function pruneOldSnapshots(db: Database, maxCount: number): number {
  const rows = db.all(
    `SELECT id FROM record WHERE type = 'codebase_snapshot' ORDER BY created_at DESC`,
  ) as unknown as Array<{ id: string }>;

  if (rows.length <= maxCount) return 0;

  const toDelete = rows.slice(maxCount);
  for (const row of toDelete) {
    db.run('DELETE FROM record WHERE id = ?', [row.id]);
  }
  return toDelete.length;
}

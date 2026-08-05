/**
 * Reap stale test temp dirs.
 *
 * Integration tests create mkdtemp dirs (`memnant-*`) and clean them in
 * afterAll — which never runs for killed or timed-out runs, so crashes leak
 * them (5,181 dirs / ~1.6GB found 2026-08-05). Called from setup-isolation.ts
 * at suite start: deletes matching dirs older than maxAgeMs, leaving live
 * runs (fresh mtimes) untouched.
 */
import { readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';

/** Delete dirs under `root` whose name starts with `prefix` and whose mtime
 *  is older than `maxAgeMs`. Returns the paths it deleted. */
export function reapStaleTmpDirs(root: string, prefix: string, maxAgeMs: number): string[] {
  const deleted: string[] = [];
  const cutoff = Date.now() - maxAgeMs;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return deleted; // temp root unreadable — nothing to reap
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const path = join(root, entry.name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      deleted.push(path);
    } catch {
      // Concurrent workers reap the same root; losing the race is expected.
    }
  }
  return deleted;
}

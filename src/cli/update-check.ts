/**
 * memnant — Non-blocking update check.
 *
 * Compares installed version against npm registry.
 * Prints a one-liner to stderr if outdated. Never blocks startup.
 * Caches the check result to avoid hitting the registry on every run.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { VERSION } from '../version.js';

const CACHE_DIR = join(homedir(), '.memnant');
const CACHE_FILE = join(CACHE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  latestVersion: string;
  checkedAt: number;
}

function readCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (typeof data.latestVersion === 'string' && typeof data.checkedAt === 'number') {
      return data as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } catch {
    // Silent — cache is best-effort
  }
}

export function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

export function checkForUpdate(): void {
  // Fire and forget — never blocks
  setImmediate(async () => {
    try {
      const cached = readCache();
      if (cached && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
        if (isNewer(cached.latestVersion, VERSION)) {
          printUpdateNotice(cached.latestVersion);
        }
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch('https://registry.npmjs.org/memnant/latest', {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!res.ok) return;

      const data = await res.json() as { version?: string };
      const latest = data.version;
      if (!latest) return;

      writeCache({ latestVersion: latest, checkedAt: Date.now() });

      if (isNewer(latest, VERSION)) {
        printUpdateNotice(latest);
      }
    } catch {
      // Silent — network errors, timeouts, etc. are fine
    }
  });
}

function printUpdateNotice(latest: string): void {
  process.stderr.write(
    `\nmemnant ${VERSION} → ${latest} available. Run: npm update -g memnant\n\n`,
  );
}

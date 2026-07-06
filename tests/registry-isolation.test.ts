/**
 * Regression: the test suite must never write to the developer's real
 * ~/.memnant. Before per-worker HOME isolation, every test that spawned
 * `memnant init` registered its temp project in the real registry
 * (~157 dead entries found by `memnant doctor`, 2026-07-06).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

describe('test-suite HOME isolation', () => {
  it('runs every worker under a fake HOME, not the real one', () => {
    const originalHome = process.env.MEMNANT_TEST_ORIGINAL_HOME;
    expect(originalHome, 'setup-isolation.ts must capture the original HOME').toBeDefined();
    expect(homedir()).not.toBe(originalHome);
    expect(homedir()).toContain('memnant-test-home-');
  });

  it('a spawned CLI init writes to the fake registry, never the real one', () => {
    const originalHome = process.env.MEMNANT_TEST_ORIGINAL_HOME as string;
    const realRegistry = join(originalHome, '.memnant', 'registry.json');
    const realBefore = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf-8') : null;

    const projectDir = mkdtempSync(join(tmpdir(), 'memnant-isolation-probe-'));
    try {
      const result = spawnSync('node', [CLI_PATH, 'init'], {
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      expect(result.status).toBe(0);

      // The registration must land under the fake HOME...
      const fakeRegistry = join(homedir(), '.memnant', 'registry.json');
      expect(existsSync(fakeRegistry)).toBe(true);
      expect(readFileSync(fakeRegistry, 'utf-8')).toContain('memnant-isolation-probe-');

      // ...and the real registry must be byte-identical to before.
      const realAfter = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf-8') : null;
      expect(realAfter).toBe(realBefore);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

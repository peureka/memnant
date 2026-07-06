/**
 * Compiled-binary smoke test.
 *
 * The bun-compiled binaries shipped broken for four months without anyone
 * noticing: src/version.ts read ../package.json from disk at import time,
 * which doesn't exist inside bun's virtual bundle filesystem ($bunfs), so
 * every binary crashed at startup. No test ever executed a compiled binary.
 * This one does. Skipped when bun isn't installed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

function findBun(): string | null {
  const home = process.env.MEMNANT_TEST_ORIGINAL_HOME ?? process.env.HOME ?? '';
  for (const p of [join(home, '.bun', 'bin', 'bun'), '/usr/local/bin/bun', '/usr/bin/bun']) {
    if (existsSync(p)) return p;
  }
  try {
    return execSync('which bun', { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

const bun = findBun();

describe.skipIf(!bun)('compiled binary', () => {
  it('starts up and reports the package version', () => {
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

    // Build dist, then compile only the host-platform binary.
    const build = spawnSync('npx', ['tsc'], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });
    expect(build.status).toBe(0);

    const hostTarget = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    const compile = spawnSync(bun as string, ['run', 'build/compile.ts', hostTarget], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 300_000,
    });
    expect(compile.status).toBe(0);

    const binary = join(ROOT, 'build', 'bin', `memnant-${hostTarget}`);
    expect(existsSync(binary)).toBe(true);

    const run = spawnSync(binary, ['--version'], { encoding: 'utf-8', timeout: 60_000 });
    expect(run.stderr).not.toContain('ENOENT');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toContain(pkgVersion);
  }, 400_000);
});

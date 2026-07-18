/**
 * Compiled-binary smoke test.
 *
 * The bun-compiled binaries shipped broken for four months without anyone
 * noticing — first a package.json read at startup, then the SQLite WASM
 * loaded from a path baked in at build time. Both bugs are invisible when
 * the binary runs on the machine that built it (the baked paths exist
 * there), so this test compiles from a throwaway copy of the repo and
 * deletes it before executing the binary: every baked path is then dead,
 * exactly like a user's machine. Skipped when bun isn't installed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execSync } from 'child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync, copyFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
  it('runs on a machine that is not the build machine', () => {
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

    const buildRoot = mkdtempSync(join(tmpdir(), 'memnant-binary-build-'));
    const workDir = join(buildRoot, 'repo');
    // -c uses APFS clonefile (instant); falls back to a normal copy elsewhere.
    let cp = spawnSync('cp', ['-Rc', `${ROOT}/`, workDir], { encoding: 'utf-8', timeout: 300_000 });
    if (cp.status !== 0) {
      cp = spawnSync('cp', ['-R', `${ROOT}/`, workDir], { encoding: 'utf-8', timeout: 300_000 });
    }
    expect(cp.status).toBe(0);

    // Build dist inside the throwaway copy, never the real repo: rewriting the
    // real dist/ mid-suite races every test that spawns `node dist/cli/index.js`
    // (transient "does not provide an export" crashes at full parallelism).
    const build = spawnSync('npx', ['tsc'], { cwd: workDir, encoding: 'utf-8', timeout: 120_000 });
    expect(build.status).toBe(0);

    const hostTarget = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    const binaryName = `memnant-${hostTarget}`;
    const binary = join(buildRoot, binaryName);

    try {
      const compile = spawnSync(bun as string, ['run', 'build/compile.ts', hostTarget], {
        cwd: workDir,
        encoding: 'utf-8',
        timeout: 300_000,
      });
      expect(compile.status).toBe(0);

      // Move the binary out, then delete the tree it was built from —
      // every path baked into the binary now points at nothing.
      copyFileSync(join(workDir, 'build', 'bin', binaryName), binary);
      chmodSync(binary, 0o755);
      rmSync(workDir, { recursive: true, force: true });

      const version = spawnSync(binary, ['--version'], { encoding: 'utf-8', timeout: 60_000 });
      expect(version.stderr).not.toContain('ENOENT');
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toContain(pkgVersion);

      // init exercises SQLite — the WASM must be embedded, not read from disk.
      const projectDir = join(buildRoot, 'project');
      spawnSync('mkdir', ['-p', projectDir]);
      const init = spawnSync(binary, ['init'], {
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      expect(init.stderr).not.toContain('ENOENT');
      expect(init.status).toBe(0);
      expect(existsSync(join(projectDir, '.memnant', 'ledger.db'))).toBe(true);
    } finally {
      rmSync(buildRoot, { recursive: true, force: true });
    }
  }, 600_000);
});

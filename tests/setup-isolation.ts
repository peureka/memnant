/**
 * Per-worker HOME isolation for the whole suite.
 *
 * Every worker (and every CLI subprocess it spawns) sees a fake HOME in
 * the OS temp dir, so nothing a test does can write to the developer's
 * real ~/.memnant, ~/.claude.json, or ~/.codex. os.homedir() reads $HOME
 * on POSIX, so overriding the env var is sufficient for both in-process
 * code and spawned CLIs, which inherit process.env.
 *
 * Tests that need their own HOME (e.g. setup.test.ts) still override it
 * per-spawn; they just start from the fake one instead of the real one.
 */
import { mkdtempSync, existsSync, symlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

if (!process.env.MEMNANT_TEST_ORIGINAL_HOME) {
  const originalHome = homedir();
  process.env.MEMNANT_TEST_ORIGINAL_HOME = originalHome;

  const fakeHome = mkdtempSync(join(tmpdir(), 'memnant-test-home-'));

  // The embedding model (~32MB) and tree-sitter grammars are read-only
  // download caches; symlink them in so isolated runs stay offline-fast.
  const fakeMemnant = join(fakeHome, '.memnant');
  mkdirSync(fakeMemnant, { recursive: true });
  for (const cache of ['runtime', 'grammars']) {
    const src = join(originalHome, '.memnant', cache);
    if (existsSync(src)) symlinkSync(src, join(fakeMemnant, cache));
  }

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
}

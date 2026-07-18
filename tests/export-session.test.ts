/**
 * Tests for `memnant export-session` — per-session markdown session log.
 *
 * Integration tests: seed CLOSED sessions via the CLI (full round-trip through
 * the embedding model + ledger), then verify the rendered markdown and the
 * resolution / error behaviour against the feature spec.
 *
 * Runs under the suite's fake-HOME isolation (tests/setup-isolation.ts), and
 * spawns the compiled CLI exactly like tests/export.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { input?: string; timeout?: number },
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 120_000,
      input: opts?.input,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      status: e.status ?? 1,
    };
  }
}

/** Seed one closed session (start → log records → close with a summary). */
function seedClosedSession(
  cwd: string,
  opts: {
    decisions?: Array<{ content: string; tags?: string }>;
    fixes?: string[];
    log: string;
  },
): void {
  runMemnant(['session', 'start'], cwd);
  for (const d of opts.decisions ?? []) {
    const args = ['log', '--type', 'decision', '--content', d.content];
    if (d.tags) args.push('--tags', d.tags);
    runMemnant(args, cwd);
  }
  for (const fx of opts.fixes ?? []) {
    runMemnant(['log', '--type', 'framework_fix', '--content', fx], cwd);
  }
  runMemnant(['session', 'close', '--log', opts.log], cwd);
}

const SESSION_A_LOG = [
  'Set up the analytics dashboard skeleton.',
  'Wired the metrics API route.',
  '',
  'TODOs:',
  '- Add auth to the metrics API',
  '- Backfill historical data',
  '',
  'Next: wire the charts to live data',
].join('\n');

describe('memnant export-session', { timeout: 180_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-export-session-'));
    runMemnant(['init'], testDir);

    // Session A: decisions (one rejected) + a framework fix + a rich log.
    seedClosedSession(testDir, {
      decisions: [
        {
          content:
            'Chose snapshot-first analytics because live aggregation adds 200ms of latency. This keeps dashboards responsive.',
          tags: 'analytics,performance',
        },
        {
          content: 'Rejected Redis for the cache layer due to operational overhead.',
          tags: 'cache,rejected',
        },
      ],
      fixes: [
        'Next.js caching fix: set revalidate to 60 for the dashboard route. Verified in staging.',
      ],
      log: SESSION_A_LOG,
    });
  }, 180_000);

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // Test 1
  it('exports a closed session to <out>/YYYY-MM-DD-<slug>.md with Goal + Done', async () => {
    const result = runMemnant(['export-session', '--latest'], testDir);
    expect(result.status).toBe(0);

    const written = result.stdout.trim();
    expect(written).toMatch(/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/);
    expect(existsSync(written)).toBe(true);

    const md = await readFile(written, 'utf-8');
    expect(md).toMatch(/^# \d{4}-\d{2}-\d{2} — .+ — /m);
    expect(md).toContain('**Goal**: Set up the analytics dashboard skeleton.');
    expect(md).toContain('**Done**:');
    expect(md).toContain('- Wired the metrics API route.');
    // Done is the narrative body only — the trailing TODOs/Next are pulled out
    // into their own sections, not duplicated as Done bullets.
    expect(md).not.toContain('- TODOs:');
    expect(md).not.toContain('- Next: wire the charts');
  });

  // Test 2
  it('includes decision records as bullets; rejected-tagged decisions get " [rejected]"', async () => {
    const result = runMemnant(['export-session', '--latest', '--force'], testDir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('**Decisions**:');
    // First sentence only, not the whole content.
    expect(md).toContain('- Chose snapshot-first analytics because live aggregation adds 200ms of latency.');
    expect(md).not.toContain('This keeps dashboards responsive');
    // Rejected-tagged decision gets the marker.
    expect(md).toContain('- Rejected Redis for the cache layer due to operational overhead. [rejected]');
  });

  // Test 3 (part a): framework fixes present render under a heading
  it('includes framework_fix records (first sentence) under a heading', async () => {
    const result = runMemnant(['export-session', '--latest', '--force'], testDir);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('**Framework fixes**:');
    expect(md).toContain('- Next.js caching fix: set revalidate to 60 for the dashboard route.');
    expect(md).not.toContain('Verified in staging');
  });

  // Test 3 (part b): omits empty sections entirely
  it('omits empty sections entirely (no fixes → no "Framework fixes" heading)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-nofix-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, {
      log: 'Wrote docs only.\nNo code shipped.',
    });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('**Done**:');
    expect(md).not.toContain('**Framework fixes**');
    expect(md).not.toContain('**Decisions**');
    expect(md).not.toContain('**Deferred to backlog**');
    expect(md).not.toContain('**Next**');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 4
  it('--latest resolves the most recently closed session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-latest-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: 'First session about the parser.' });
    seedClosedSession(dir, { log: 'Second session about the billing flow.' });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('**Goal**: Second session about the billing flow.');
    expect(md).not.toContain('parser');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 5 (part a): unique id-prefix resolution works
  it('resolves a unique id prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-prefix-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: 'Prefix resolution session.' });

    // Read the real session id from the ledger (session start prints its id to
    // stderr, which execFileSync discards on success).
    const { openDatabase } = await import('../dist/ledger/database.js');
    const db = openDatabase(join(dir, '.memnant', 'ledger.db'));
    const row = db.get(
      'SELECT id FROM session WHERE closed_at IS NOT NULL LIMIT 1',
    ) as { id: string };
    db.close();
    expect(row.id).toMatch(/^[0-9a-f]{8}/);

    const result = runMemnant(['export-session', row.id.slice(0, 6)], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');
    expect(md).toContain('**Goal**: Prefix resolution session.');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 5 (part b): ambiguous prefix errors listing candidates
  it('errors on an ambiguous id prefix, listing candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-ambig-'));
    runMemnant(['init'], dir);

    // Insert two closed sessions sharing the prefix "abcd" directly, so the
    // ambiguity is deterministic (uuids never collide otherwise).
    const { openDatabase } = await import('../dist/ledger/database.js');
    const db = openDatabase(join(dir, '.memnant', 'ledger.db'));
    const proj = db.get('SELECT id FROM project LIMIT 1') as { id: string };
    const now = new Date().toISOString();
    for (const suffix of ['1111', '2222']) {
      db.run(
        `INSERT INTO session (id, project_id, started_at, closed_at, stories_completed)
         VALUES (?, ?, ?, ?, '[]')`,
        [`abcd${suffix}-0000-0000-0000-000000000000`, proj.id, now, now],
      );
    }
    db.close();

    const result = runMemnant(['export-session', 'abcd'], dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ambiguous');
    expect(result.stderr).toContain('abcd1111');
    expect(result.stderr).toContain('abcd2222');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 6
  it('unknown session id → non-zero exit + lists recent closed sessions', async () => {
    const result = runMemnant(['export-session', 'deadbeef'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("No closed session found matching 'deadbeef'");
    expect(result.stderr).toContain('Recent closed sessions:');
    // Should list the seeded session A (8-char id prefix present).
    expect(result.stderr).toMatch(/[0-9a-f]{8}\s+\d{4}-\d{2}-\d{2}/);
  });

  // Test 6b: no arg and no --latest → helpful error
  it('no arg and no --latest → helpful error listing recent closed sessions', async () => {
    const result = runMemnant(['export-session'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Specify a session id or use --latest');
    expect(result.stderr).toMatch(/[0-9a-f]{8}\s+\d{4}-\d{2}-\d{2}/);
  });

  // Test 7
  it('refuses to overwrite an existing target without --force; overwrites with --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-force-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: 'Session for the force test.' });

    const first = runMemnant(['export-session', '--latest', '--slug', 'fixed'], dir);
    expect(first.status).toBe(0);
    const target = first.stdout.trim();
    expect(target.endsWith('-fixed.md')).toBe(true);

    // Second run, same target, no --force → refuse.
    const refuse = runMemnant(['export-session', '--latest', '--slug', 'fixed'], dir);
    expect(refuse.status).not.toBe(0);
    expect(refuse.stderr).toContain('already exists');
    expect(refuse.stderr).toContain('--force');

    // With --force → succeeds.
    const forced = runMemnant(['export-session', '--latest', '--slug', 'fixed', '--force'], dir);
    expect(forced.status).toBe(0);
    expect(forced.stdout.trim()).toBe(target);

    await rm(dir, { recursive: true, force: true });
  });

  // Test 8
  it('slug falls back to slugified summary; --slug wins when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-slug-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, {
      log: 'Refactored the auth token flow completely today.',
    });

    // Fallback: first ~5 words slugified.
    const fallback = runMemnant(['export-session', '--latest'], dir);
    expect(fallback.status).toBe(0);
    expect(fallback.stdout.trim()).toMatch(/-refactored-the-auth-token-flow\.md$/);

    // --slug wins.
    const custom = runMemnant(['export-session', '--latest', '--slug', 'my-custom-slug'], dir);
    expect(custom.status).toBe(0);
    expect(custom.stdout.trim()).toMatch(/-my-custom-slug\.md$/);

    // Files land in the default export_path.
    const files = await readdir(join(dir, '.memnant', 'export'));
    expect(files.some((f) => f.endsWith('-my-custom-slug.md'))).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});

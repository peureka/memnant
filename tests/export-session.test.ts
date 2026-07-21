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
    // Header uses the middle-dot separator, not em dashes (product ethos).
    expect(md).toMatch(/^# \d{4}-\d{2}-\d{2} · .+ · /m);
    const header = md.split('\n')[0];
    expect(header).not.toContain('—');
    expect(header).not.toContain('–');
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

  // ── Inline-heading (legacy single-line) summaries ──────────────────────
  //
  // Legacy session logs written as ONE long line with inline markers
  // ("Shipped: … Decisions: … TODOs: … Next: …") must be split into segments
  // at those markers, instead of dumping the whole line into Goal + Done.

  /** Return the "**Heading**: …" block for a heading, or '' if absent. */
  function sectionBlock(md: string, heading: string): string {
    return md.split('\n\n').find((b) => b.startsWith(`**${heading}**`)) ?? '';
  }

  const INLINE_LOG =
    'Fixed the exporter and serve idle. ' +
    'Shipped: parse inline markers; render Decision field. ' +
    'Decisions: chose detached mode over lazy resolution. ' +
    'Rejected: full per-call resolution. ' +
    'Gotchas: zsh globs abort compound commands. ' +
    'TODOs: add colony dedup; profile slow tests. ' +
    'Next: wire the PR gates.';

  // Test 1 (item 1a): Goal = first sentence of pre-marker text only
  it('inline-marker summary: Goal is the first sentence of the pre-marker text only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-inline-goal-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: INLINE_LOG });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('**Goal**: Fixed the exporter and serve idle.');
    // The whole paragraph must NOT leak into Goal.
    expect(md).not.toContain('**Goal**: Fixed the exporter and serve idle. Shipped:');
    expect(sectionBlock(md, 'Goal')).not.toContain('Shipped:');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 2 (item 1a): Done = Shipped bullets; no Decisions/Rejected/Gotchas/TODOs/Next text
  it('inline-marker summary: Done is the Shipped segment split on "; " and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-inline-done-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: INLINE_LOG });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    const done = sectionBlock(md, 'Done');
    expect(done).toContain('- parse inline markers');
    expect(done).toContain('- render Decision field');
    // No text from the other inline segments leaks into Done.
    expect(done).not.toContain('chose detached mode');
    expect(done).not.toContain('full per-call resolution');
    expect(done).not.toContain('zsh globs abort');
    expect(done).not.toContain('add colony dedup');
    expect(done).not.toContain('wire the PR gates');
    // Decisions/Rejected/Gotchas segments are dropped entirely (no records here).
    expect(md).not.toContain('chose detached mode');
    expect(md).not.toContain('full per-call resolution');
    expect(md).not.toContain('zsh globs abort');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 3 (item 1a): Deferred = TODOs items; Next = Next segment
  it('inline-marker summary: Deferred is the TODOs items and Next is the Next segment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-inline-tail-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: INLINE_LOG });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    const deferred = sectionBlock(md, 'Deferred to backlog');
    expect(deferred).toContain('- add colony dedup');
    expect(deferred).toContain('- profile slow tests');

    expect(md).toContain('**Next**: wire the PR gates.');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 4 (item 1a regression): multi-line structured summaries render as today
  it('multi-line structured summary keeps today\'s line-based rendering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-multiline-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, { log: SESSION_A_LOG });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('**Goal**: Set up the analytics dashboard skeleton.');
    expect(sectionBlock(md, 'Done')).toContain('- Wired the metrics API route.');
    expect(sectionBlock(md, 'Deferred to backlog')).toContain('- Add auth to the metrics API');
    expect(md).toContain('**Next**: wire the charts to live data');
    // TODOs marker line is not duplicated as a Done bullet.
    expect(md).not.toContain('- TODOs:');

    await rm(dir, { recursive: true, force: true });
  });

  // ── Templated record rendering (item 1b) ───────────────────────────────

  // Test 5: templated decision renders the Decision field, not the Question field
  it('templated decision renders the Decision field first sentence; rejected suffix preserved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-decision-tpl-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, {
      decisions: [
        {
          content:
            'Question: Should we adopt Redis? Context: A cache layer is needed. Decision: Rejected Redis in favour of an in-process LRU. Adds no ops overhead. Rationale: Operational simplicity for a solo builder.',
          tags: 'cache,rejected',
        },
      ],
      log: 'Reviewed the cache options.',
    });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    expect(md).toContain('- Rejected Redis in favour of an in-process LRU. [rejected]');
    // Not the Question field, not the trailing sentence of the Decision field.
    expect(md).not.toContain('Should we adopt Redis');
    expect(md).not.toContain('Adds no ops overhead');

    await rm(dir, { recursive: true, force: true });
  });

  // Test 6: templated framework_fix renders the Solution field; plain fixes unchanged
  it('templated framework_fix renders the Solution field; fixes without fields are unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnant-export-session-fix-tpl-'));
    runMemnant(['init'], dir);
    seedClosedSession(dir, {
      fixes: [
        'Problem: The dashboard route served stale data. Solution: Set revalidate to 60 on the route. Verified in staging. Context: Next.js App Router.',
        'Plain fix note: bump the node engine to 20 in package.json.',
      ],
      log: 'Fixed the caching and engine pin.',
    });

    const result = runMemnant(['export-session', '--latest'], dir);
    expect(result.status).toBe(0);
    const md = await readFile(result.stdout.trim(), 'utf-8');

    // Templated fix → Solution field first sentence.
    expect(md).toContain('- Set revalidate to 60 on the route.');
    expect(md).not.toContain('The dashboard route served stale data');
    expect(md).not.toContain('Verified in staging');
    // Plain fix without fields → first sentence unchanged.
    expect(md).toContain('- Plain fix note: bump the node engine to 20 in package.json.');

    await rm(dir, { recursive: true, force: true });
  });
});

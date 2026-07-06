/**
 * Tests for Story 5.2: Copy Audit Check
 *
 * See docs/PLAN.md, Story 5.2 for the full AC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(
  args: string[],
  cwd: string,
  opts?: { input?: string },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    input: opts?.input,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('memnant check-copy', { timeout: 30_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-checkcopy-'));
    await writeFile(join(testDir, 'index.ts'), 'export const main = () => {};\n');
    runMemnant(['init'], testDir);

    await mkdir(join(testDir, 'docs'), { recursive: true });
    await writeFile(join(testDir, 'docs', 'copy-audit.md'), [
      '---',
      'type: copy_audit',
      'version: 1',
      'applies_to: all',
      '---',
      '# Copy Audit',
      '',
      '## Banned Phrases',
      '- "platform" → "product"',
      '- "leverage" — corporate jargon',
      '',
      '## Discouraged Phrases',
      '- "We\'re happy to help" — too generic, rephrase',
      '- "click here" — use descriptive link text',
      '',
      '## Tone Rules',
      '- max_sentence_length: 20 — keep sentences short',
    ].join('\n'));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC: detects banned phrases
  it('detects banned phrases', () => {
    const result = runMemnant(
      ['check-copy', 'Welcome to our platform! We leverage AI to help you.'],
      testDir,
    );
    expect(result.status).not.toBe(0); // non-zero for banned
    expect(result.stdout).toContain('[BANNED]');
    expect(result.stdout).toContain('platform');
    expect(result.stdout).toContain('leverage');
  });

  // AC: detects discouraged phrases
  it('detects discouraged phrases', () => {
    const result = runMemnant(
      ["check-copy", "We're happy to help you get started. Click here for more."],
      testDir,
    );
    expect(result.stdout).toContain('[DISCOURAGED]');
    expect(result.stdout).toContain('happy to help');
  });

  // AC: reports tone violations (sentence too long)
  it('detects tone violations', () => {
    const longSentence = 'This is a very long sentence that goes on and on and on and on and on and on and on and on and never seems to end because we keep adding more words.';
    const result = runMemnant(['check-copy', longSentence], testDir);
    expect(result.stdout).toContain('[TONE]');
    expect(result.stdout).toContain('exceeds max length');
  });

  // AC: shows replacement suggestions
  it('shows replacement suggestions for banned phrases', () => {
    const result = runMemnant(
      ['check-copy', 'Welcome to the platform.'],
      testDir,
    );
    expect(result.stdout).toContain('"product"');
  });

  // AC: exit code is non-zero for banned phrases
  it('exits with non-zero for banned phrases', () => {
    const result = runMemnant(
      ['check-copy', 'This platform is great.'],
      testDir,
    );
    expect(result.status).not.toBe(0);
  });

  // AC: exit code is zero for only discouraged (no banned)
  it('exits with zero for only discouraged phrases', () => {
    const result = runMemnant(
      ['check-copy', "We're happy to help."],
      testDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[DISCOURAGED]');
  });

  // AC: clean text passes
  it('passes for clean text', () => {
    const result = runMemnant(
      ['check-copy', 'Start your free trial today.'],
      testDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No copy violations');
  });

  // AC: --file checks an entire file
  it('checks a file with --file', async () => {
    await writeFile(join(testDir, 'marketing.txt'), 'Our platform leverages AI to deliver results.\n');
    const result = runMemnant(
      ['check-copy', '--file', 'marketing.txt'],
      testDir,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('marketing.txt');
    expect(result.stdout).toContain('[BANNED]');
  });

  // AC: no copy audit spec → helpful message
  it('shows helpful message when no copy audit spec', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-nocopy-'));
    runMemnant(['init'], emptyDir);
    const result = runMemnant(['check-copy', 'Hello world'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No copy audit spec found');
    await rm(emptyDir, { recursive: true, force: true });
  });
});

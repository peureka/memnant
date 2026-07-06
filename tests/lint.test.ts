/**
 * Tests for Story 5.5: CI Integration
 *
 * See docs/PLAN.md, Story 5.5 for the full AC.
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
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('memnant lint', { timeout: 30_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-lint-'));
    await writeFile(join(testDir, 'index.ts'), 'export const main = () => {};\n');
    runMemnant(['init'], testDir);

    await mkdir(join(testDir, 'docs'), { recursive: true });

    // Copy audit spec
    await writeFile(join(testDir, 'docs', 'copy-rules.md'), [
      '---',
      'type: copy_audit',
      'version: 1',
      'applies_to: all',
      '---',
      '# Copy Rules',
      '',
      '## Banned Phrases',
      '- "click here" → "select" — vague CTA',
      '',
      '## Discouraged Phrases',
      '- "please" — unnecessary filler',
      '',
      '## Tone',
      '- max_sentence_length: 20',
    ].join('\n'));

    // Design system spec
    await writeFile(join(testDir, 'docs', 'design-system.md'), [
      '---',
      'type: design_system',
      'version: 1',
      'applies_to: all',
      '---',
      '# Design System',
      '',
      '## Banned Components',
      '- "Modal" → "InlineExpansion" — modals break mobile flow',
    ].join('\n'));

    // Source files
    await mkdir(join(testDir, 'src', 'components'), { recursive: true });

    // File with banned component
    await writeFile(join(testDir, 'src', 'components', 'Dialog.tsx'), [
      'import React from "react";',
      '',
      'export function ConfirmDialog() {',
      '  return <Modal open={true}><p>Are you sure?</p></Modal>;',
      '}',
    ].join('\n'));

    // Clean file
    await writeFile(join(testDir, 'src', 'components', 'Button.tsx'), [
      'import React from "react";',
      '',
      'export function Button({ children }: { children: React.ReactNode }) {',
      '  return <button className="btn">{children}</button>;',
      '}',
    ].join('\n'));

    // File with copy violations
    await writeFile(join(testDir, 'src', 'components', 'Help.md'), [
      '# Help Page',
      '',
      'Please click here to get started.',
    ].join('\n'));

    // File with only discouraged (no banned)
    await writeFile(join(testDir, 'src', 'components', 'Intro.md'), [
      '# Intro',
      '',
      'Please read the docs.',
    ].join('\n'));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC: runs all applicable checks
  it('detects both copy audit and design system violations', () => {
    const result = runMemnant(['lint', 'src'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Modal');
    expect(result.stdout).toContain('click here');
  });

  // AC: exits non-zero for banned violations
  it('exits non-zero when banned violations found', () => {
    const result = runMemnant(['lint', 'src/components/Dialog.tsx'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('[BANNED]');
  });

  // AC: exits 0 if all checks pass
  it('exits 0 for clean files', () => {
    const result = runMemnant(['lint', 'src/components/Button.tsx'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All checks passed');
  });

  // AC: discouraged violations produce warnings but not non-zero exit
  it('exits 0 for only discouraged violations', () => {
    const result = runMemnant(['lint', 'src/components/Intro.md'], testDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[DISCOURAGED]');
    expect(result.stdout).toContain('please');
  });

  // AC: --strict treats discouraged as errors
  it('--strict exits non-zero for discouraged violations', () => {
    const result = runMemnant(['lint', '--strict', 'src/components/Intro.md'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('[DISCOURAGED]');
  });

  // AC: output is CI-friendly, file:line format
  it('outputs in file:line format', () => {
    const result = runMemnant(['lint', 'src/components/Dialog.tsx'], testDir);
    expect(result.stdout).toMatch(/Dialog\.tsx:\d+/);
  });

  // AC: shows violation summary
  it('shows violation summary', () => {
    const result = runMemnant(['lint', 'src'], testDir);
    expect(result.stdout).toContain('violation(s)');
    expect(result.stdout).toContain('banned');
    expect(result.stdout).toContain('discouraged');
  });

  // AC: no spec documents → exit 0, helpful message
  it('shows helpful message when no spec documents', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-nolint-'));
    await writeFile(join(emptyDir, 'app.tsx'), 'export function App() { return <Modal />; }\n');
    runMemnant(['init'], emptyDir);
    const result = runMemnant(['lint', 'app.tsx'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No spec documents found. Nothing to lint.');
    await rm(emptyDir, { recursive: true, force: true });
  });

  // AC: can lint default directory (.)
  it('lints current directory by default', () => {
    const result = runMemnant(['lint'], testDir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Modal');
  });
});

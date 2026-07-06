/**
 * Tests for Story 5.3: Design System Validation
 *
 * See docs/PLAN.md, Story 5.3 for the full AC.
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

describe('memnant check-design', { timeout: 30_000 }, () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-checkdesign-'));
    await writeFile(join(testDir, 'index.ts'), 'export const main = () => {};\n');
    runMemnant(['init'], testDir);

    await mkdir(join(testDir, 'docs'), { recursive: true });
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
      '- "Tooltip" — inaccessible on touch devices',
      '- "Carousel" → "StaticGrid" — carousels have poor engagement',
    ].join('\n'));

    // Create source files
    await mkdir(join(testDir, 'src', 'components'), { recursive: true });
    await writeFile(join(testDir, 'src', 'components', 'Dialog.tsx'), [
      'import React from "react";',
      '',
      'export function ConfirmDialog() {',
      '  return <Modal open={true}><p>Are you sure?</p></Modal>;',
      '}',
    ].join('\n'));

    await writeFile(join(testDir, 'src', 'components', 'Button.tsx'), [
      'import React from "react";',
      '',
      'export function Button({ children }: { children: React.ReactNode }) {',
      '  return <button className="btn">{children}</button>;',
      '}',
    ].join('\n'));

    await writeFile(join(testDir, 'src', 'components', 'Info.tsx'), [
      'import React from "react";',
      '',
      '// Show a tooltip with extra information',
      'export function InfoIcon() {',
      '  return <Tooltip content="More info"><Icon name="info" /></Tooltip>;',
      '}',
    ].join('\n'));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // AC: detects banned components in a single file
  it('detects banned components in a file', () => {
    const result = runMemnant(
      ['check-design', 'src/components/Dialog.tsx'],
      testDir,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('[BANNED]');
    expect(result.stdout).toContain('Modal');
    expect(result.stdout).toContain('Dialog.tsx');
  });

  // AC: shows line numbers
  it('shows file:line format', () => {
    const result = runMemnant(
      ['check-design', 'src/components/Dialog.tsx'],
      testDir,
    );
    expect(result.stdout).toMatch(/Dialog\.tsx:\d+/);
  });

  // AC: suggests replacement
  it('shows replacement from design system', () => {
    const result = runMemnant(
      ['check-design', 'src/components/Dialog.tsx'],
      testDir,
    );
    expect(result.stdout).toContain('InlineExpansion');
  });

  // AC: scans directory recursively
  it('scans a directory recursively', () => {
    const result = runMemnant(
      ['check-design', 'src'],
      testDir,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Modal');
    expect(result.stdout).toContain('Tooltip');
  });

  // AC: clean file passes
  it('passes for clean files', () => {
    const result = runMemnant(
      ['check-design', 'src/components/Button.tsx'],
      testDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No design system violations');
  });

  // AC: exit code is non-zero for banned
  it('exits non-zero when violations found', () => {
    const result = runMemnant(
      ['check-design', 'src/components/Info.tsx'],
      testDir,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Tooltip');
  });

  // No design system spec → helpful message
  it('shows helpful message when no design system spec', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'memnant-nodesign-'));
    await writeFile(join(emptyDir, 'app.tsx'), 'export function App() { return <Modal />; }\n');
    runMemnant(['init'], emptyDir);
    const result = runMemnant(['check-design', 'app.tsx'], emptyDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No design system spec found');
    await rm(emptyDir, { recursive: true, force: true });
  });
});

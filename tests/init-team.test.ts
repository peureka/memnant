import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import yaml from 'js-yaml';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function run(...args: string[]) {
  return (cwd: string) =>
    execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env },
      stdio: 'ignore',
    });
}

describe('memnant init --team', () => {
  const tmpDir = join(process.cwd(), '.tmp-init-team-test');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test Builder'], { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets project.builder from git config user.name', () => {
    run('init', '--non-interactive', '--team')(tmpDir);

    const configPath = join(tmpDir, 'memnant.yaml');
    expect(existsSync(configPath)).toBe(true);

    const config = yaml.load(readFileSync(configPath, 'utf-8')) as any;
    expect(config.project.builder).toBe('Test Builder');
  });

  it('appends .memnant/ledger.db to .gitignore', () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n');

    run('init', '--non-interactive', '--team')(tmpDir);

    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.memnant/ledger.db');
  });

  it('creates .gitignore with entry when none exists', () => {
    // Don't create a .gitignore - let --team create it
    run('init', '--non-interactive', '--team')(tmpDir);

    const gitignorePath = join(tmpDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.memnant/ledger.db');
  });

  it('does not duplicate .memnant/ledger.db in .gitignore if already present', () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n.memnant/ledger.db\n');

    run('init', '--non-interactive', '--team')(tmpDir);

    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.memnant\/ledger\.db/g);
    expect(matches?.length).toBe(1);
  });
});

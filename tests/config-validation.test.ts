/**
 * Tests for config validation — loadConfig().
 *
 * Task 1: Shared config loader that validates parsed YAML
 * before returning it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, ConfigError, findProjectRoot } from '../src/config/load.js';

describe('loadConfig', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-config-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads a valid config file', async () => {
    const yaml = `
project:
  id: test-project
  name: Test Project
memory:
  db_path: .memnant/ledger.db
  export_path: .memnant/export/
  snapshot_interval: monthly
  max_spec_snapshots: 5
  max_codebase_snapshots: 3
orchestrator:
  tiers:
    triage:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    analysis:
      provider: anthropic
      model: claude-sonnet-4-5-20250929
    build:
      provider: anthropic
      model: claude-opus-4-6
  interfaces:
    telegram:
      enabled: false
    cli:
      enabled: true
    mcp:
      enabled: true
      port: 3100
governor:
  docs_path: docs/
  lint_on_pr: true
  strict_mode: false
security:
  staging_only: true
  allow_deploy: false
  allowed_mcp_tools: []
`;
    await writeFile(join(testDir, 'memnant.yaml'), yaml);

    const config = loadConfig(testDir);

    expect(config.project.id).toBe('test-project');
    expect(config.project.name).toBe('Test Project');
    expect(config.memory.db_path).toBe('.memnant/ledger.db');
  });

  it('throws ConfigError when config file does not exist', () => {
    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(
      /No memnant project found.*Run `memnant init` first/,
    );
  });

  it('throws ConfigError on missing project.id', async () => {
    const yaml = `
project:
  name: Test Project
memory:
  db_path: .memnant/ledger.db
  export_path: .memnant/export/
  snapshot_interval: monthly
  max_spec_snapshots: 5
  max_codebase_snapshots: 3
orchestrator:
  tiers:
    triage:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    analysis:
      provider: anthropic
      model: claude-sonnet-4-5-20250929
    build:
      provider: anthropic
      model: claude-opus-4-6
  interfaces:
    telegram:
      enabled: false
    cli:
      enabled: true
    mcp:
      enabled: true
      port: 3100
governor:
  docs_path: docs/
  lint_on_pr: true
  strict_mode: false
security:
  staging_only: true
  allow_deploy: false
  allowed_mcp_tools: []
`;
    await writeFile(join(testDir, 'memnant.yaml'), yaml);

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/project\.id/);
  });

  it('throws ConfigError on missing project section', async () => {
    const yaml = `
memory:
  db_path: .memnant/ledger.db
  export_path: .memnant/export/
  snapshot_interval: monthly
  max_spec_snapshots: 5
  max_codebase_snapshots: 3
`;
    await writeFile(join(testDir, 'memnant.yaml'), yaml);

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/project\.id/);
  });

  it('throws ConfigError on missing memory.db_path', async () => {
    const yaml = `
project:
  id: test-project
  name: Test Project
memory:
  export_path: .memnant/export/
  snapshot_interval: monthly
  max_spec_snapshots: 5
  max_codebase_snapshots: 3
orchestrator:
  tiers:
    triage:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    analysis:
      provider: anthropic
      model: claude-sonnet-4-5-20250929
    build:
      provider: anthropic
      model: claude-opus-4-6
  interfaces:
    telegram:
      enabled: false
    cli:
      enabled: true
    mcp:
      enabled: true
      port: 3100
governor:
  docs_path: docs/
  lint_on_pr: true
  strict_mode: false
security:
  staging_only: true
  allow_deploy: false
  allowed_mcp_tools: []
`;
    await writeFile(join(testDir, 'memnant.yaml'), yaml);

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/memory\.db_path/);
  });

  it('throws ConfigError on malformed YAML', async () => {
    await writeFile(join(testDir, 'memnant.yaml'), '{{{{invalid yaml: [[[');

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/Failed to parse memnant\.yaml/);
  });

  it('throws ConfigError on missing project.name', async () => {
    const yaml = `
project:
  id: test-project
memory:
  db_path: .memnant/ledger.db
  export_path: .memnant/export/
  snapshot_interval: monthly
  max_spec_snapshots: 5
  max_codebase_snapshots: 3
orchestrator:
  tiers:
    triage:
      provider: anthropic
      model: claude-haiku-4-5-20251001
    analysis:
      provider: anthropic
      model: claude-sonnet-4-5-20250929
    build:
      provider: anthropic
      model: claude-opus-4-6
  interfaces:
    telegram:
      enabled: false
    cli:
      enabled: true
    mcp:
      enabled: true
      port: 3100
governor:
  docs_path: docs/
  lint_on_pr: true
  strict_mode: false
security:
  staging_only: true
  allow_deploy: false
  allowed_mcp_tools: []
`;
    await writeFile(join(testDir, 'memnant.yaml'), yaml);

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/project\.name/);
  });

  it('throws ConfigError when YAML parses to a non-object', async () => {
    await writeFile(join(testDir, 'memnant.yaml'), 'just a string');

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/project\.id/);
  });

  it('throws ConfigError when YAML is empty', async () => {
    await writeFile(join(testDir, 'memnant.yaml'), '');

    expect(() => loadConfig(testDir)).toThrow(ConfigError);
    expect(() => loadConfig(testDir)).toThrow(/project\.id/);
  });
});

describe('findProjectRoot', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-find-root-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('finds memnant.yaml in the given directory', async () => {
    await writeFile(join(testDir, 'memnant.yaml'), 'project:\n  id: test\n  name: Test\nmemory:\n  db_path: .memnant/ledger.db\n');
    expect(findProjectRoot(testDir)).toBe(testDir);
  });

  it('finds memnant.yaml in a parent directory', async () => {
    await writeFile(join(testDir, 'memnant.yaml'), 'project:\n  id: test\n  name: Test\nmemory:\n  db_path: .memnant/ledger.db\n');
    const subDir = join(testDir, 'sub', 'deep');
    await mkdir(subDir, { recursive: true });
    expect(findProjectRoot(subDir)).toBe(testDir);
  });

  it('returns null when no memnant.yaml found', () => {
    expect(findProjectRoot(testDir)).toBeNull();
  });
});

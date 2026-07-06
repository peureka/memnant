/**
 * Tests for the machine-local project registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Project Registry', () => {
  let testDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-registry-'));
    registryPath = join(testDir, 'registry.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('loadRegistry', () => {
    it('returns empty projects array when file does not exist', async () => {
      const { loadRegistry } = await import('../src/registry/registry.js');
      const reg = loadRegistry(registryPath);
      expect(reg.projects).toEqual([]);
    });

    it('loads existing registry', async () => {
      const { writeFileSync } = await import('fs');
      writeFileSync(registryPath, JSON.stringify({
        projects: [{ id: 'abc', name: 'test', root_path: '/tmp/test', added_at: '2026-01-01T00:00:00Z' }],
      }));
      const { loadRegistry } = await import('../src/registry/registry.js');
      const reg = loadRegistry(registryPath);
      expect(reg.projects).toHaveLength(1);
      expect(reg.projects[0].name).toBe('test');
    });
  });

  describe('addProject', () => {
    it('adds a project to the registry', async () => {
      const { loadRegistry, addProject, saveRegistry } = await import('../src/registry/registry.js');
      const reg = loadRegistry(registryPath);
      addProject(reg, { id: 'abc', name: 'my-app', root_path: '/tmp/my-app' });
      saveRegistry(registryPath, reg);

      const reloaded = loadRegistry(registryPath);
      expect(reloaded.projects).toHaveLength(1);
      expect(reloaded.projects[0].name).toBe('my-app');
      expect(reloaded.projects[0].added_at).toBeTruthy();
    });

    it('skips duplicate project by id', async () => {
      const { loadRegistry, addProject } = await import('../src/registry/registry.js');
      const reg = loadRegistry(registryPath);
      addProject(reg, { id: 'abc', name: 'my-app', root_path: '/tmp/my-app' });
      addProject(reg, { id: 'abc', name: 'my-app-v2', root_path: '/tmp/my-app' });
      expect(reg.projects).toHaveLength(1);
    });
  });

  describe('removeProject', () => {
    it('removes a project by name', async () => {
      const { loadRegistry, addProject, removeProject } = await import('../src/registry/registry.js');
      const reg = loadRegistry(registryPath);
      addProject(reg, { id: 'abc', name: 'my-app', root_path: '/tmp/my-app' });
      const removed = removeProject(reg, 'my-app');
      expect(removed).toBe(true);
      expect(reg.projects).toHaveLength(0);
    });

    it('returns false for unknown project', async () => {
      const { loadRegistry, removeProject } = await import('../src/registry/registry.js');
      const reg = loadRegistry(registryPath);
      const removed = removeProject(reg, 'nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('getRegistryPath', () => {
    it('returns path in home directory', async () => {
      const { getRegistryPath } = await import('../src/registry/registry.js');
      const path = getRegistryPath();
      expect(path).toContain('.memnant');
      expect(path).toContain('registry.json');
    });
  });

  describe('CLI registration', () => {
    it('projects command is registered in CLI index', async () => {
      const { readFileSync } = await import('fs');
      const indexCode = readFileSync('src/cli/index.ts', 'utf-8');
      expect(indexCode).toContain('registerProjectsCommand');
    });

    it('init auto-registers project in registry', async () => {
      const { readFileSync } = await import('fs');
      const initCode = readFileSync('src/cli/init.ts', 'utf-8');
      expect(initCode).toContain('addProject');
    });
  });
});

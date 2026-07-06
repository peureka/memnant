/**
 * Tests for the spec validator plugin system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Plugin System', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-plugins-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('SpecValidator interface', () => {
    it('exports the loadPlugins and runPlugins functions', async () => {
      const mod = await import('../src/governor/plugins.js');
      expect(mod.loadPlugins).toBeDefined();
      expect(mod.runPlugins).toBeDefined();
    });
  });

  describe('loadPlugins', () => {
    it('returns empty array when no plugins configured', async () => {
      const { loadPlugins } = await import('../src/governor/plugins.js');
      const plugins = await loadPlugins(undefined, testDir);
      expect(plugins).toEqual([]);
    });

    it('loads a plugin from a JS file', async () => {
      const pluginCode = `
export default {
  name: 'test-plugin',
  specTypes: ['copy_audit'],
  validate(content, spec) {
    const violations = [];
    if (content.includes('TODO')) {
      violations.push({ message: 'Found TODO', severity: 'warning' });
    }
    return violations;
  }
};
`;
      const pluginDir = join(testDir, 'validators');
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, 'todo-check.mjs'), pluginCode);

      const { loadPlugins } = await import('../src/governor/plugins.js');
      const config = {
        'todo-check': { enabled: true, script: './validators/todo-check.mjs' },
      };
      const plugins = await loadPlugins(config, testDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('test-plugin');
    });

    it('skips disabled plugins', async () => {
      const { loadPlugins } = await import('../src/governor/plugins.js');
      const config = {
        'disabled': { enabled: false, script: './nope.js' },
      };
      const plugins = await loadPlugins(config, testDir);
      expect(plugins).toEqual([]);
    });
  });

  describe('runPlugins', () => {
    it('collects violations from plugins', async () => {
      const { runPlugins } = await import('../src/governor/plugins.js');
      const fakePlugin = {
        name: 'test',
        specTypes: ['copy_audit'],
        validate: (content: string) => {
          if (content.includes('bad')) {
            return [{ message: 'Found bad', severity: 'banned' as const }];
          }
          return [];
        },
      };
      const result = runPlugins([fakePlugin], 'this is bad content', { type: 'copy_audit' } as any);
      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('bad');
    });

    it('skips plugins that do not handle the spec type', async () => {
      const { runPlugins } = await import('../src/governor/plugins.js');
      const fakePlugin = {
        name: 'test',
        specTypes: ['design_system'],
        validate: () => [{ message: 'Should not run', severity: 'banned' as const }],
      };
      const result = runPlugins([fakePlugin], 'content', { type: 'copy_audit' } as any);
      expect(result).toEqual([]);
    });
  });

  describe('types', () => {
    it('ProjectConfig has optional plugins in governor', () => {
      const typesCode = readFileSync('src/types.ts', 'utf-8');
      expect(typesCode).toContain('plugins?');
    });
  });
});

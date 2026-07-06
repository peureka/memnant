import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('version consistency', () => {
  it('VERSION exports the package.json version', async () => {
    const { VERSION } = await import('../src/version.js');
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('no hardcoded 0.1.0 in key src files', () => {
    const files = ['src/cli/index.ts', 'src/mcp/server.ts', 'src/cli/export.ts'];
    for (const file of files) {
      const content = readFileSync(join(process.cwd(), file), 'utf-8');
      expect(content, `${file} still has hardcoded 0.1.0`).not.toContain("'0.1.0'");
    }
  });
});

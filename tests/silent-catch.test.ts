import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('no silent catch blocks', () => {
  const srcFiles = [
    'src/mcp/server.ts',
    'src/cli/harvest.ts',
    'src/cli/synthesise.ts',
  ];

  for (const file of srcFiles) {
    it(`${file} has no empty catch blocks`, () => {
      const content = readFileSync(join(process.cwd(), file), 'utf-8');
      const emptyMatches = content.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g);
      expect(emptyMatches, `Found empty catch blocks: ${JSON.stringify(emptyMatches)}`).toBeNull();
    });
  }
});

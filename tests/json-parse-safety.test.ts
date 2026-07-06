import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('JSON.parse safety', () => {
  const tmp = join(tmpdir(), `memnant-json-test-${Date.now()}`);

  beforeEach(() => mkdirSync(tmp, { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('importSharedRecords skips malformed JSON files', async () => {
    const sharedDir = join(tmp, 'shared');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'bad-record.json'), 'NOT VALID JSON{{{');

    const { importSharedRecords } = await import('../src/team/sync.js');
    const mockDb = {
      get: () => undefined,
      run: vi.fn(),
      all: () => [],
    };
    const count = await importSharedRecords(mockDb as any, 'proj-1', sharedDir);
    expect(count).toBe(0);
  });
});

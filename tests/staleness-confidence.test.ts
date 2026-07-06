import { describe, it, expect } from 'vitest';
import { formatStaleDescription } from '../src/context/compile.js';

describe('staleness confidence display', () => {
  it('shows confidence in stale decision description', () => {
    const desc = formatStaleDescription(
      'abc12345',
      '2025-01-01',
      'Use Postgres for auth',
      ['src/auth.ts'],
      0.72,
    );

    expect(desc).toContain('abc12345');
    expect(desc).toContain('confidence: 0.72');
    expect(desc).toContain('src/auth.ts');
  });

  it('shows confidence: 1.00 for binary staleness', () => {
    const desc = formatStaleDescription(
      'def67890',
      '2025-02-01',
      'Axios timeout fix',
      ['dep: axios'],
      1.0,
    );

    expect(desc).toContain('confidence: 1.00');
  });

  it('omits confidence when undefined', () => {
    const desc = formatStaleDescription(
      'ghi11111',
      '2025-03-01',
      'Some record',
      ['src/foo.ts'],
    );

    expect(desc).not.toContain('confidence');
    expect(desc).toContain('ghi11111');
  });
});

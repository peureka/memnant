import { describe, it, expect } from 'vitest';
import { isNewer, checkForUpdate } from '../src/cli/update-check.js';

describe('update check', () => {
  it('exports checkForUpdate', () => {
    expect(typeof checkForUpdate).toBe('function');
  });

  it('detects newer major version', () => {
    expect(isNewer('2.0.0', '1.13.0')).toBe(true);
  });

  it('detects newer minor version', () => {
    expect(isNewer('1.14.0', '1.13.0')).toBe(true);
  });

  it('detects newer patch version', () => {
    expect(isNewer('1.13.1', '1.13.0')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewer('1.13.0', '1.13.0')).toBe(false);
  });

  it('returns false for older version', () => {
    expect(isNewer('1.12.0', '1.13.0')).toBe(false);
  });

  it('checkForUpdate does not throw', () => {
    expect(() => checkForUpdate()).not.toThrow();
  });
});

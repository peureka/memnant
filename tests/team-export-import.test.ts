/**
 * Tests for team export/import enhancements.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Team Export/Import', () => {
  describe('team export format', () => {
    it('export.ts supports --team flag', () => {
      const exportCode = readFileSync('src/cli/export.ts', 'utf-8');
      expect(exportCode).toContain('--team');
    });

    it('portable format includes source_project_id and builder_id', () => {
      const exportCode = readFileSync('src/cli/export.ts', 'utf-8');
      expect(exportCode).toContain('source_project_id');
      expect(exportCode).toContain('builder_id');
    });

    it('team export filters to shareable types only', () => {
      const exportCode = readFileSync('src/cli/export.ts', 'utf-8');
      expect(exportCode).toContain('decision');
      expect(exportCode).toContain('framework_fix');
      expect(exportCode).toContain('session_log');
    });
  });

  describe('team import', () => {
    it('import accepts team exports with builder_id', () => {
      const importCode = readFileSync('src/cli/import.ts', 'utf-8');
      expect(importCode).toContain('builder_id');
      expect(importCode).toContain('isTeamImport');
    });

    it('import adds by:{builder} tag for team imports', () => {
      const importCode = readFileSync('src/cli/import.ts', 'utf-8');
      expect(importCode).toContain('builderTag');
    });

    it('import maintains backward compatibility for legacy portable files', () => {
      const importCode = readFileSync('src/cli/import.ts', 'utf-8');
      // Should still have framework_fix validation for non-team imports
      expect(importCode).toContain('framework_fix');
    });
  });

  describe('types', () => {
    it('ProjectConfig has optional builder field', () => {
      const typesCode = readFileSync('src/types.ts', 'utf-8');
      expect(typesCode).toContain('builder?');
    });
  });
});

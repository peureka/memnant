/**
 * Tests for Epic 7 instruction sections.
 *
 * Verifies that all composable instruction sections exist and contain
 * the expected patterns for instinctive logging.
 */

import { describe, it, expect } from 'vitest';
import {
  claudeCodeInstructions,
  sectionDecisionDetection,
  sectionFrameworkFixDetection,
  sectionRejectionLogging,
  sectionLoggingTasteGuide,
  sectionSessionClose,
  sectionMcpTools,
  sectionWorkflow,
} from '../src/cli/instructions.js';

describe('Epic 7: Instinctive Logging instruction sections', () => {
  describe('Story 7.1 — Decision Pattern Detection', () => {
    it('has a decision detection section', () => {
      const section = sectionDecisionDetection();
      expect(section).toContain('Instinctive Logging: Decisions');
    });

    it('lists detection patterns', () => {
      const section = sectionDecisionDetection();
      expect(section).toContain("Let's go with");
      expect(section).toContain('over Y because');
    });

    it('instructs agent to log silently', () => {
      const section = sectionDecisionDetection();
      expect(section).toContain('silently');
    });

    it('includes content structure', () => {
      const section = sectionDecisionDetection();
      expect(section).toContain('Question');
      expect(section).toContain('Context');
      expect(section).toContain('Decision');
      expect(section).toContain('Rationale');
    });
  });

  describe('Story 7.2 — Framework Fix Detection', () => {
    it('has a framework fix section', () => {
      const section = sectionFrameworkFixDetection();
      expect(section).toContain('Instinctive Logging: Framework Fixes');
    });

    it('describes the error→fix→verify pattern', () => {
      const section = sectionFrameworkFixDetection();
      expect(section).toContain('error');
      expect(section).toContain('fix');
      expect(section).toContain('verify');
    });

    it('says to log after verification, not on first error', () => {
      const section = sectionFrameworkFixDetection();
      expect(section).toContain('AFTER verification');
    });
  });

  describe('Story 7.3 — Rejection Logging', () => {
    it('has a rejection section', () => {
      const section = sectionRejectionLogging();
      expect(section).toContain('Instinctive Logging: Rejections');
    });

    it('lists rejection patterns', () => {
      const section = sectionRejectionLogging();
      expect(section).toContain("didn't work because");
      expect(section).toContain('Tried X but');
    });

    it('instructs tagging as rejected', () => {
      const section = sectionRejectionLogging();
      expect(section).toContain('rejected');
    });
  });

  describe('Story 7.4 — Logging Taste Guide', () => {
    it('has a taste guide section', () => {
      const section = sectionLoggingTasteGuide();
      expect(section).toContain('Logging Taste Guide');
    });

    it('lists what is worth logging', () => {
      const section = sectionLoggingTasteGuide();
      expect(section).toContain('Worth logging');
      expect(section).toContain('Architecture decisions');
    });

    it('lists what is not worth logging', () => {
      const section = sectionLoggingTasteGuide();
      expect(section).toContain('Not worth logging');
      expect(section).toContain('formatting');
    });

    it('includes the 3-week threshold test', () => {
      const section = sectionLoggingTasteGuide();
      expect(section).toContain('3 weeks');
    });

    it('includes density guidance', () => {
      const section = sectionLoggingTasteGuide();
      expect(section).toContain('1-3 sentences');
    });
  });

  describe('Story 8.3 — Session Close instructions', () => {
    it('has a session close section', () => {
      const section = sectionSessionClose();
      expect(section).toContain('Session Log vs Session Close');
    });

    it('distinguishes session_log from session_close', () => {
      const section = sectionSessionClose();
      expect(section).toContain('session_log');
      expect(section).toContain('session_close');
      expect(section).toContain('Default to');
    });

    it('includes summary template categories', () => {
      const section = sectionSessionClose();
      expect(section).toContain('Shipped');
      expect(section).toContain('Decisions');
      expect(section).toContain('Rejected');
      expect(section).toContain('Gotchas');
      expect(section).toContain('TODOs');
    });
  });

  describe('Full claude-code instructions include all sections', () => {
    const full = claudeCodeInstructions(null);

    it('includes all MCP tools', () => {
      expect(full).toContain('recall');
      expect(full).toContain('session_close');
      expect(full).toContain('synthesise');
      expect(full).toContain('project_brief');
    });

    it('includes all instruction sections', () => {
      expect(full).toContain('Instinctive Logging: Decisions');
      expect(full).toContain('Instinctive Logging: Framework Fixes');
      expect(full).toContain('Instinctive Logging: Rejections');
      expect(full).toContain('Logging Taste Guide');
      expect(full).toContain('Session Close');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { renderTemplateBriefing, composeLlmBriefing, buildBriefingPrompt } from '../src/context/narrative.js';
import { daysSinceLastSession } from '../src/context/compile.js';
import type { CompiledContext } from '../src/types.js';

const baseContext: CompiledContext = {
  token_estimate: 500,
  warnings: [],
  sections: {
    last_session: 'Shipped: auth flow. Decided: JWT over sessions. TODO: add refresh tokens.',
    open_todos: ['Add refresh token rotation', 'Wire up logout endpoint'],
    epic_context: null,
    framework_fixes: ['[d2a8] Next.js 15: useSearchParams needs Suspense boundary'],
    spec_constraints: [],
    persona_tests: [],
    stale_decisions: ['[c4d9] [stale 0.72] Analytics schema — analytics.ts changed'],
    override_suggestions: [],
  },
};

describe('narrative template briefing', () => {
  it('renders a delta-focused briefing', () => {
    const briefing = renderTemplateBriefing(baseContext, { daysSinceLastSession: 21 });
    expect(briefing).toContain('21 days');
    expect(briefing).toContain('auth flow');
    expect(briefing).toContain('refresh token');
  });

  it('omits empty sections', () => {
    const sparseContext: CompiledContext = {
      ...baseContext,
      sections: {
        ...baseContext.sections,
        stale_decisions: [],
        framework_fixes: [],
        override_suggestions: [],
      },
    };
    const briefing = renderTemplateBriefing(sparseContext, { daysSinceLastSession: 1 });
    expect(briefing).not.toContain('stale');
    expect(briefing).not.toContain('Framework');
  });

  it('includes colony fixes when provided', () => {
    const briefing = renderTemplateBriefing(baseContext, {
      daysSinceLastSession: 5,
      colonyFixes: ['[colony] React setState batching in event handlers'],
    });
    expect(briefing).toContain('colony');
    expect(briefing).toContain('React setState');
  });

  it('includes pattern callouts when provided', () => {
    const briefing = renderTemplateBriefing(baseContext, {
      daysSinceLastSession: 5,
      patterns: ['Prefers server components over client state (4 decisions)'],
    });
    expect(briefing).toContain('Pattern');
    expect(briefing).toContain('server components');
  });
});

describe('narrative LLM briefing', () => {
  it('builds a prompt from compiled context', () => {
    const prompt = buildBriefingPrompt(baseContext, { daysSinceLastSession: 14 });
    expect(prompt).toContain('14 days');
    expect(prompt).toContain('auth flow');
    expect(prompt).toContain('stale');
  });

  it('composeLlmBriefing returns template fallback when LLM unavailable', async () => {
    const result = await composeLlmBriefing(baseContext, {
      daysSinceLastSession: 7,
      tierConfig: null,
    });
    expect(result.fallback).toBe(true);
    expect(result.text).toContain('7 days');
  });
});

describe('daysSinceLastSession helper', () => {
  it('returns days between now and a date string', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const days = daysSinceLastSession(twoWeeksAgo);
    expect(days).toBeGreaterThanOrEqual(13);
    expect(days).toBeLessThanOrEqual(15);
  });

  it('returns 0 when no last session', () => {
    expect(daysSinceLastSession(null)).toBe(0);
  });
});

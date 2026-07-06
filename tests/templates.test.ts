import { describe, it, expect } from 'vitest';
import { validateTemplate } from '../src/ledger/templates.js';
import type { ProjectConfig } from '../src/types.js';

const configWithTemplates = {
  memory: {
    templates: {
      decision: {
        required_fields: ['question', 'decision', 'rationale'],
        optional_fields: ['context', 'alternatives'],
      },
      framework_fix: {
        required_fields: ['problem', 'solution'],
        optional_fields: ['environment', 'verification'],
      },
    },
  },
} as unknown as ProjectConfig;

const configNoTemplates = {
  memory: {},
} as unknown as ProjectConfig;

describe('template validation', () => {
  it('passes when all required fields present', () => {
    const content = `Question: Should we use Postgres?
Decision: Yes, use Postgres.
Rationale: Better JSON support.`;

    const result = validateTemplate('decision', content, configWithTemplates);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing required fields', () => {
    const content = `Question: Should we use Postgres?
Decision: Yes, use Postgres.`;

    const result = validateTemplate('decision', content, configWithTemplates);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['rationale']);
  });

  it('is case-insensitive for field labels', () => {
    const content = `QUESTION: Should we use Postgres?
decision: Yes.
RATIONALE: Because.`;

    const result = validateTemplate('decision', content, configWithTemplates);
    expect(result.valid).toBe(true);
  });

  it('returns valid when no template configured for type', () => {
    const result = validateTemplate('session_log', 'anything', configWithTemplates);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('returns valid when no templates in config at all', () => {
    const result = validateTemplate('decision', 'anything', configNoTemplates);
    expect(result.valid).toBe(true);
  });

  it('validates framework_fix template', () => {
    const content = `Problem: CORS errors on API calls.`;
    const result = validateTemplate('framework_fix', content, configWithTemplates);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['solution']);
  });
});

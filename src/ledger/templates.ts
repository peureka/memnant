/**
 * Decision templates — advisory validation for record content.
 *
 * Checks that content text contains expected field labels for the record type.
 * Returns warnings for missing fields. Never blocks record creation.
 */

import type { ProjectConfig } from '../types.js';

export interface TemplateResult {
  valid: boolean;
  missing: string[];
}

export function validateTemplate(
  type: string,
  contentText: string,
  config: ProjectConfig,
): TemplateResult {
  const templates = (config.memory as any).templates;
  if (!templates) return { valid: true, missing: [] };

  const template = templates[type];
  if (!template) return { valid: true, missing: [] };

  const requiredFields: string[] = template.required_fields ?? [];
  if (requiredFields.length === 0) return { valid: true, missing: [] };

  const lowerContent = contentText.toLowerCase();
  const missing: string[] = [];

  for (const field of requiredFields) {
    const label = field.toLowerCase();
    const hasPlain = lowerContent.includes(`${label}:`);
    const hasBold = lowerContent.includes(`**${label}:**`);
    if (!hasPlain && !hasBold) {
      missing.push(field);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

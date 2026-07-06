/**
 * memnant — Design system validation.
 *
 * Story 5.3: Scans source files for banned components from the design system spec.
 */

import { scanSpecs, extractSpecDetail } from './specs.js';

export interface DesignViolation {
  file: string;
  line: number;
  message: string;
  term: string;
}

export interface DesignCheckResult {
  violations: DesignViolation[];
  hasBanned: boolean;
}

/**
 * Check source code for banned components.
 */
export function checkDesign(code: string, filename: string, docsPath: string): DesignCheckResult {
  const specs = scanSpecs(docsPath);
  const designSpec = specs.find((s) => s.frontmatter.type === 'design_system');

  if (!designSpec) {
    return { violations: [], hasBanned: false };
  }

  const detail = extractSpecDetail(designSpec);
  const violations: DesignViolation[] = [];
  const lines = code.split('\n');

  for (const banned of detail.banned) {
    const escaped = banned.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        let msg = `[BANNED] "${banned.term}" is a banned component.`;
        if (banned.reason) msg += ` Design system says: "${banned.reason}"`;
        if (banned.replacement) msg += ` Use "${banned.replacement}" instead.`;
        violations.push({
          file: filename,
          line: i + 1,
          message: msg,
          term: banned.term,
        });
      }
    }
  }

  return { violations, hasBanned: violations.length > 0 };
}

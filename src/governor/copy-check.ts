/**
 * memnant — Copy audit checker.
 *
 * Story 5.2: Checks text against copy audit spec rules.
 * Reports banned phrases, discouraged phrases, and tone violations.
 */

import { scanSpecs, extractSpecDetail, type SpecDocument, type BannedItem, type DiscouragedItem, type ToneRule } from './specs.js';

export type ViolationLevel = 'banned' | 'discouraged' | 'tone';

export interface CopyViolation {
  level: ViolationLevel;
  message: string;
  line?: number;
  term?: string;
}

export interface CopyCheckResult {
  violations: CopyViolation[];
  hasBanned: boolean;
}

/**
 * Check text against copy audit spec.
 */
export function checkCopy(text: string, docsPath: string): CopyCheckResult {
  const specs = scanSpecs(docsPath);
  const copySpec = specs.find((s) => s.frontmatter.type === 'copy_audit');

  if (!copySpec) {
    return { violations: [], hasBanned: false };
  }

  return checkCopyAgainstSpec(text, copySpec);
}

export function checkCopyAgainstSpec(text: string, spec: SpecDocument): CopyCheckResult {
  const detail = extractSpecDetail(spec);
  const violations: CopyViolation[] = [];
  const lines = text.split('\n');

  // Check banned phrases
  for (const banned of detail.banned) {
    for (let i = 0; i < lines.length; i++) {
      if (containsTerm(lines[i], banned.term)) {
        let msg = `[BANNED] "${banned.term}"`;
        if (banned.replacement) msg += ` → use "${banned.replacement}"`;
        if (banned.reason) msg += ` — ${banned.reason}`;
        violations.push({ level: 'banned', message: msg, line: i + 1, term: banned.term });
      }
    }
  }

  // Check discouraged phrases
  for (const disc of detail.discouraged) {
    for (let i = 0; i < lines.length; i++) {
      if (containsTerm(lines[i], disc.term)) {
        let msg = `[DISCOURAGED] "${disc.term}"`;
        if (disc.replacement) msg += ` → "${disc.replacement}"`;
        if (disc.reason) msg += ` — ${disc.reason}`;
        violations.push({ level: 'discouraged', message: msg, line: i + 1, term: disc.term });
      }
    }
  }

  // Check tone rules
  for (const rule of detail.tone_rules) {
    if (rule.type === 'max_sentence_length' && typeof rule.value === 'number') {
      for (let i = 0; i < lines.length; i++) {
        const sentences = lines[i].split(/[.!?]+/).filter((s) => s.trim());
        for (const sentence of sentences) {
          const wordCount = sentence.trim().split(/\s+/).length;
          if (wordCount > rule.value) {
            violations.push({
              level: 'tone',
              message: `[TONE] Sentence exceeds max length (${wordCount} words, max ${rule.value})`,
              line: i + 1,
            });
          }
        }
      }
    }
  }

  const hasBanned = violations.some((v) => v.level === 'banned');
  return { violations, hasBanned };
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');
  return regex.test(text);
}

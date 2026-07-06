/**
 * memnant — Spec document parsing and registration.
 *
 * Story 5.1: Discovers and parses spec documents from the docs directory.
 * Specs are identified by YAML frontmatter with a `type` field.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export const SPEC_TYPES = [
  'design_system',
  'copy_audit',
  'persona',
  'data_model',
  'product_spec',
] as const;

export type SpecType = (typeof SPEC_TYPES)[number];

export interface SpecFrontmatter {
  type: SpecType;
  version?: number | string;
  last_reviewed?: string;
  applies_to?: string | string[];
  [key: string]: unknown;
}

export interface SpecDocument {
  filename: string;
  frontmatter: SpecFrontmatter;
  body: string;
}

export interface BannedItem {
  term: string;
  reason?: string;
  replacement?: string;
}

export interface DiscouragedItem {
  term: string;
  reason?: string;
  replacement?: string;
}

export interface ToneRule {
  type: string;
  value: number | string;
  description: string;
}

export interface SpecDetail {
  banned: BannedItem[];
  discouraged: DiscouragedItem[];
  required: string[];
  test_questions: string[];
  tone_rules: ToneRule[];
}

/**
 * Parse YAML frontmatter from a markdown file.
 */
export function parseFrontmatter(content: string): { frontmatter: SpecFrontmatter | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  try {
    const fm: Record<string, unknown> = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
      const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
      if (kv) {
        const value = kv[2].trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          fm[kv[1]] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        } else if (/^\d+$/.test(value)) {
          fm[kv[1]] = parseInt(value, 10);
        } else {
          fm[kv[1]] = value.replace(/^["']|["']$/g, '');
        }
      }
    }

    if (!fm.type || !SPEC_TYPES.includes(fm.type as SpecType)) {
      return { frontmatter: null, body: content };
    }

    return { frontmatter: fm as unknown as SpecFrontmatter, body: match[2] };
  } catch {
    return { frontmatter: null, body: content };
  }
}

/**
 * Scan the docs directory for spec documents.
 */
export function scanSpecs(docsPath: string): SpecDocument[] {
  if (!existsSync(docsPath)) return [];

  const specs: SpecDocument[] = [];
  let files: string[];
  try {
    files = readdirSync(docsPath).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  for (const file of files) {
    const content = readFileSync(join(docsPath, file), 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (frontmatter) {
      specs.push({ filename: file, frontmatter, body });
    }
  }

  return specs;
}

/**
 * Extract structured constraints from a spec document.
 */
export function extractSpecDetail(spec: SpecDocument): SpecDetail {
  const detail: SpecDetail = {
    banned: [],
    discouraged: [],
    required: [],
    test_questions: [],
    tone_rules: [],
  };

  const lines = spec.body.split('\n');
  let currentSection = '';

  for (const line of lines) {
    // Track sections
    if (/^##\s+.*[Bb]anned/i.test(line)) {
      currentSection = 'banned';
      continue;
    }
    if (/^##\s+.*[Dd]iscouraged/i.test(line)) {
      currentSection = 'discouraged';
      continue;
    }
    if (/^##\s+.*[Rr]equired/i.test(line)) {
      currentSection = 'required';
      continue;
    }
    if (/^##\s+.*[Tt]one/i.test(line)) {
      currentSection = 'tone';
      continue;
    }
    if (/^##\s+.*[Tt]est/i.test(line) || /^##\s+.*[Qq]uestion/i.test(line)) {
      currentSection = 'questions';
      continue;
    }
    if (/^##\s/.test(line)) {
      currentSection = '';
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed === '-' || trimmed === '*') continue;

    // Parse list items
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (!listMatch) continue;
    const item = listMatch[1];

    switch (currentSection) {
      case 'banned': {
        const parsed = parseItemWithReplacement(item);
        detail.banned.push(parsed);
        break;
      }
      case 'discouraged': {
        const parsed = parseItemWithReplacement(item);
        detail.discouraged.push(parsed);
        break;
      }
      case 'required':
        detail.required.push(item);
        break;
      case 'tone': {
        const toneMatch = item.match(/^(.+?):\s*(.+?)(?:\s*[-—]\s*(.+))?$/);
        if (toneMatch) {
          const val = /^\d+$/.test(toneMatch[2]) ? parseInt(toneMatch[2], 10) : toneMatch[2];
          detail.tone_rules.push({
            type: toneMatch[1].trim().toLowerCase().replace(/\s+/g, '_'),
            value: val,
            description: toneMatch[3]?.trim() ?? toneMatch[2].trim(),
          });
        }
        break;
      }
      case 'questions':
        if (item.endsWith('?')) {
          detail.test_questions.push(item);
        }
        break;
    }
  }

  // Also extract questions from anywhere in the body (lines ending with ?)
  if (spec.frontmatter.type === 'persona') {
    for (const line of lines) {
      const trimmed = line.trim().replace(/^[-*]\s+/, '');
      if (trimmed.endsWith('?') && trimmed.length > 10 && !detail.test_questions.includes(trimmed)) {
        detail.test_questions.push(trimmed);
      }
    }
  }

  return detail;
}

function parseItemWithReplacement(item: string): BannedItem {
  // Pattern: "term" → "replacement" — reason
  const arrowMatch = item.match(/^"([^"]+)"\s*(?:→|->)+\s*"([^"]+)"(?:\s*[-—]\s*(.+))?$/);
  if (arrowMatch) {
    return { term: arrowMatch[1], replacement: arrowMatch[2], reason: arrowMatch[3]?.trim() };
  }
  // Pattern: `term` → replacement
  const backtickMatch = item.match(/^`([^`]+)`\s*(?:→|->)+\s*(.+)$/);
  if (backtickMatch) {
    return { term: backtickMatch[1], replacement: backtickMatch[2].trim() };
  }
  // Pattern: "term" — reason
  const quoteMatch = item.match(/^"([^"]+)"(?:\s*[-—]\s*(.+))?$/);
  if (quoteMatch) {
    return { term: quoteMatch[1], reason: quoteMatch[2]?.trim() };
  }
  // Plain text
  return { term: item };
}

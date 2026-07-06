/**
 * memnant — Claude Code memory type mapping and filtering.
 *
 * Maps Claude Code memory types to memnant record types.
 * Filters out files that should not be imported.
 */

import type { RecordType } from '../types.js';
import type { ClaudeMemoryFile } from './memory-parser.js';

export interface TypeMapping {
  memnantType: RecordType;
  tags: string[];
}

const TYPE_MAP: Record<string, TypeMapping | null> = {
  user: null, // Skip personal identity
  feedback: { memnantType: 'decision', tags: ['from:claude-memory', 'feedback'] },
  project: { memnantType: 'decision', tags: ['from:claude-memory', 'project'] },
  reference: { memnantType: 'framework_fix', tags: ['from:claude-memory', 'reference'] },
  unknown: { memnantType: 'decision', tags: ['from:claude-memory'] },
};

/** Map a Claude Code memory type to a memnant record type. Returns null to skip. */
export function mapMemoryType(claudeType: string): TypeMapping | null {
  return TYPE_MAP[claudeType] ?? TYPE_MAP.unknown!;
}

/** Determine if a memory file should be skipped. */
export function shouldSkipFile(memory: ClaudeMemoryFile): string | null {
  // Always skip MEMORY.md (it's an index)
  if (memory.fileName === 'MEMORY.md') return 'index';

  // Skip user type
  if (memory.type === 'user') return 'type:user';

  // Skip files that are mostly tables (repos.md, products.md)
  if (isTableHeavy(memory.content)) return 'table-heavy';

  return null;
}

function isTableHeavy(content: string): boolean {
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return false;
  const tableLines = lines.filter((l) => l.includes('|') && l.trim().startsWith('|'));
  return tableLines.length / lines.length > 0.5;
}

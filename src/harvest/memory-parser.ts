/**
 * memnant — Claude Code memory file parser.
 *
 * Parses markdown files with YAML frontmatter from Claude Code's memory system.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

export interface ClaudeMemoryFile {
  name: string;
  description: string;
  type: string;
  content: string;
  filePath: string;
  fileName: string;
}

/**
 * Parse a Claude Code memory file.
 * Returns null for files that fail to parse or have no useful content.
 */
export function parseMemoryFile(filePath: string): ClaudeMemoryFile | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const fileName = basename(filePath);
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try to parse frontmatter
  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (match) {
    const frontmatter = parseFrontmatter(match[1]);
    const body = match[2].trim();
    if (!body) return null;

    return {
      name: frontmatter.name || fileName.replace('.md', ''),
      description: frontmatter.description || '',
      type: frontmatter.type || 'unknown',
      content: body,
      filePath,
      fileName,
    };
  }

  // No frontmatter — use filename-derived metadata
  return {
    name: fileName.replace('.md', ''),
    description: '',
    type: inferTypeFromFilename(fileName),
    content: trimmed,
    filePath,
    fileName,
  };
}

function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].trim();
    }
  }
  return result;
}

function inferTypeFromFilename(fileName: string): string {
  if (fileName.startsWith('feedback_')) return 'feedback';
  if (fileName.startsWith('project_') || fileName.startsWith('circuit_') || fileName.startsWith('lineconic_')) return 'project';
  if (fileName.startsWith('user_')) return 'user';
  if (fileName.startsWith('reference_')) return 'reference';
  return 'unknown';
}

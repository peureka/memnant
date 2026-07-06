/**
 * Living profile — generated markdown from pattern records.
 */

import { join } from 'path';
import { homedir } from 'os';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

const PROFILE_STRENGTH_THRESHOLD = 5;
const PROFILE_DECAY_DAYS = 180;

interface PatternRow {
  id: string;
  content_text: string;
  tags: string;
  pattern_strength: number;
  pattern_last_seen: string;
  supporting_records: string;
}

function isDecayed(lastSeen: string): boolean {
  const ms = Date.now() - new Date(lastSeen).getTime();
  return ms > PROFILE_DECAY_DAYS * 24 * 60 * 60 * 1000;
}

function categorize(text: string, tags: string[]): 'tech' | 'architecture' | 'rejected' | 'gotcha' {
  if (tags.includes('rejected') || /\brejected?\b/i.test(text) || /\bavoids?\b/i.test(text)) {
    return 'rejected';
  }
  if (/\b(?:fix|error|bug|issue|boundary|wrapper)\b/i.test(text)) {
    return 'gotcha';
  }
  if (/\bover\b/i.test(text) || /\binstead\b/i.test(text) || /\bprefers?\b/i.test(text)) {
    return 'tech';
  }
  return 'architecture';
}

export function generateProfile(colonyDb: any): string {
  const rows = colonyDb.all(
    `SELECT id, content_text, tags, pattern_strength, pattern_last_seen, supporting_records
     FROM record
     WHERE type = 'pattern'
       AND retracted_at IS NULL
       AND pattern_strength >= ?`,
    [PROFILE_STRENGTH_THRESHOLD]
  ) as PatternRow[];

  const active = rows.filter(r => !isDecayed(r.pattern_last_seen));

  if (active.length === 0) return '';

  const sections: Record<string, string[]> = {
    tech: [],
    architecture: [],
    rejected: [],
    gotcha: [],
  };

  for (const row of active) {
    const tags = JSON.parse(row.tags) as string[];
    const category = categorize(row.content_text, tags);
    sections[category].push(`- ${row.content_text}`);
  }

  const lines: string[] = [
    '# memnant — Living Profile',
    '> Auto-generated. Do not edit. Disagree? Log a contradicting decision.',
    '',
  ];

  if (sections.tech.length > 0) {
    lines.push('## Tech Preferences', ...sections.tech, '');
  }
  if (sections.architecture.length > 0) {
    lines.push('## Architecture Patterns', ...sections.architecture, '');
  }
  if (sections.rejected.length > 0) {
    lines.push('## Rejected Approaches', ...sections.rejected, '');
  }
  if (sections.gotcha.length > 0) {
    lines.push('## Framework Gotchas', ...sections.gotcha, '');
  }

  return lines.join('\n');
}

export function getProfilePath(): string {
  return join(homedir(), '.memnant', 'PROFILE.md');
}

export function writeProfile(content: string): void {
  const profilePath = getProfilePath();
  const dir = join(homedir(), '.memnant');
  mkdirSync(dir, { recursive: true });

  if (content === '') {
    return;
  }

  writeFileSync(profilePath, content, 'utf-8');
}

export function readProfile(): string | null {
  const profilePath = getProfilePath();
  if (!existsSync(profilePath)) return null;
  return readFileSync(profilePath, 'utf-8');
}

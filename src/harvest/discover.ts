/**
 * Transcript discovery — finds Claude Code conversation transcripts.
 *
 * Claude Code stores transcripts as JSONL in ~/.claude/projects/<slug>/
 * Each conversation is a UUID.jsonl file.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function getTranscriptDir(projectRoot: string): string {
  const slug = projectRoot.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

export function findTranscripts(dir: string): string[] {
  try {
    const entries = readdirSync(dir);
    return entries
      .filter(e => e.endsWith('.jsonl'))
      .map(e => join(dir, e));
  } catch {
    return [];
  }
}

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * All .jsonl transcripts in a slug dir (main sessions + agent-*.jsonl),
 * sorted by modification time, oldest first.
 */
export function findTranscriptsByMtime(dir: string): TranscriptFile[] {
  return findTranscripts(dir)
    .map((path) => {
      const s = statSync(path);
      return { path, mtimeMs: s.mtimeMs, size: s.size };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export function findLatestTranscript(dir: string): string | null {
  const transcripts = findTranscripts(dir);
  if (transcripts.length === 0) return null;

  let latest = transcripts[0];
  let latestMtime = statSync(latest).mtimeMs;

  for (let i = 1; i < transcripts.length; i++) {
    const mtime = statSync(transcripts[i]).mtimeMs;
    if (mtime > latestMtime) {
      latest = transcripts[i];
      latestMtime = mtime;
    }
  }

  return latest;
}

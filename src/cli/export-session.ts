/**
 * memnant export-session — Render one closed session as a markdown session log.
 *
 * Resolves a single CLOSED session (by full id, unique id prefix, or --latest),
 * gathers its session_log / decision / framework_fix records, and writes ONE
 * markdown file to <out>/YYYY-MM-DD-<slug>.md.
 *
 * This complements `memnant export` (which dumps the whole ledger by record
 * type). export-session is the per-session, human-readable session log — the
 * kind you commit to docs/session-logs/.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import type { Session } from '../types.js';

interface SessionRow {
  id: string;
  project_id: string;
  started_at: string;
  closed_at: string | null;
  epic: string | null;
  stories_completed: string;
  log_record_id: string | null;
  log_skipped: string | null;
}

interface RecordRow {
  id: string;
  type: string;
  content_text: string;
  tags: string;
  created_at: string;
}

/** Local YYYY-MM-DD for an ISO timestamp. */
function localDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** First non-empty, trimmed line of a block of text. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** First sentence: up to the first ., ! or ? — else the first line. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : flat;
}

/** slugify first ~5 words: lowercase, hyphens, punctuation stripped. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return slug || 'session';
}

/** Inline section markers used by legacy single-line summaries. */
const INLINE_MARKERS = 'Shipped|Decisions|Rejected|Gotchas|TODOs|Deferred|Next';

/**
 * True if `summary` is a legacy single-line paragraph carrying inline section
 * markers ("Shipped: … Decisions: … TODOs: … Next: …"). Multi-line summaries
 * (markers on their own lines) are left to the line-based parsing below.
 */
function hasInlineMarkers(summary: string): boolean {
  const trimmed = summary.trim();
  if (trimmed.includes('\n')) return false;
  return new RegExp(`\\b(?:${INLINE_MARKERS}):`, 'i').test(trimmed);
}

/**
 * Split a single-line inline-marker summary into the text before the first
 * marker (`pre`, the Goal source) and a map of marker name → segment text.
 */
function parseInlineSegments(line: string): { pre: string; segments: Map<string, string> } {
  const markerRe = new RegExp(`\\b(${INLINE_MARKERS}):`, 'gi');
  const matches = [...line.matchAll(markerRe)];
  const segments = new Map<string, string>();
  if (matches.length === 0) return { pre: line.trim(), segments };

  const pre = line.slice(0, matches[0].index).trim();
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].toLowerCase();
    const start = (matches[i].index as number) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index as number) : line.length;
    segments.set(name, line.slice(start, end).trim());
  }
  return { pre, segments };
}

/** Fields recognised in templated decision and framework_fix record content. */
const DECISION_FIELDS = ['Question', 'Context', 'Decision', 'Rationale'];
const FIX_FIELDS = ['Problem', 'Context', 'Solution'];

/**
 * Extract a single template field's value from record content, bounded by the
 * next known field label (or end of text). Returns null when the field is
 * absent — callers then fall back to `firstSentence` of the whole content.
 */
function extractField(content: string, field: string, allFields: string[]): string | null {
  const flat = content.replace(/\s+/g, ' ').trim();
  const start = flat.match(new RegExp(`\\b${field}:\\s*`, 'i'));
  if (!start || start.index === undefined) return null;

  const rest = flat.slice(start.index + start[0].length);
  let end = rest.length;
  for (const other of allFields) {
    if (other.toLowerCase() === field.toLowerCase()) continue;
    const m = rest.match(new RegExp(`\\b${other}:`, 'i'));
    if (m && m.index !== undefined && m.index < end) end = m.index;
  }
  const value = rest.slice(0, end).trim();
  return value || null;
}

/** True if a line looks like a section heading (e.g. "TODOs:", "## Next"). */
function isHeading(line: string): boolean {
  const s = line.replace(/^#+\s*/, '').trim();
  return /^(todos|deferred|next|goal|done|decisions|framework fixes|rejected|gotchas|shipped)\b/i.test(
    s,
  );
}

/** True if a line is a trailing structured section (TODOs/Deferred/Next). */
function isTrailingSection(line: string): boolean {
  const s = line.replace(/^#+\s*/, '').trim();
  return /^(todos|deferred|next)\s*:?/i.test(s);
}

/**
 * Split the session-log body into bullets: one per non-empty line, markers
 * stripped. The trailing TODOs:/Deferred:/Next: sections are excluded — they
 * render under their own headings, so keeping them here would duplicate them.
 */
function splitBullets(text: string): string[] {
  const bullets: string[] = [];
  for (const raw of text.split('\n')) {
    if (isTrailingSection(raw)) break;
    const line = raw.trim();
    if (!line) continue;
    bullets.push(line.replace(/^[-*•]\s*/, ''));
  }
  if (bullets.length === 0 && text.trim()) return [text.trim()];
  return bullets;
}

/**
 * Done bullets for one session_log record. Inline-marker logs contribute only
 * their "Shipped:" segment (split on "; "); everything else uses splitBullets.
 */
function logToDoneBullets(content: string): string[] {
  if (hasInlineMarkers(content)) {
    const shipped = parseInlineSegments(content.trim()).segments.get('shipped');
    if (!shipped) return [];
    const parts = shipped.split('; ').map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [shipped];
  }
  return splitBullets(content);
}

/** Lines under a "TODOs:" or "Deferred:" heading, until the next heading/blank. */
function parseDeferred(summary: string): string[] {
  const lines = summary.split('\n');
  const out: string[] = [];
  let capturing = false;
  for (const raw of lines) {
    const stripped = raw.replace(/^#+\s*/, '').trim();
    const isTarget = /^(todos|deferred)\s*:?\s*$/i.test(stripped);
    if (!capturing) {
      if (isTarget) capturing = true;
      continue;
    }
    // capturing
    if (raw.trim() === '') break;
    if (isHeading(raw)) break;
    out.push(raw.trim().replace(/^[-*•]\s*/, ''));
  }
  return out;
}

/** The last "Next:" line's content from the summary, if any. */
function parseNext(summary: string): string | null {
  let next: string | null = null;
  for (const raw of summary.split('\n')) {
    const stripped = raw.replace(/^#+\s*/, '').trim();
    const m = stripped.match(/^next\s*:\s*(.+)$/i);
    if (m) next = m[1].trim();
  }
  return next;
}

function rowToSession(row: SessionRow): Session {
  return { ...row, stories_completed: JSON.parse(row.stories_completed) };
}

function recentClosed(
  db: import('../ledger/database.js').Database,
  limit: number,
): Array<{ id: string; closed_at: string; summary: string | null }> {
  const rows = db.all(
    `SELECT s.id AS id, s.closed_at AS closed_at, r.content_text AS summary
     FROM session s
     LEFT JOIN record r ON r.id = s.log_record_id
     WHERE s.closed_at IS NOT NULL
     ORDER BY s.closed_at DESC
     LIMIT ?`,
    [limit],
  ) as unknown as Array<{ id: string; closed_at: string; summary: string | null }>;
  return rows;
}

function formatRecentList(
  rows: Array<{ id: string; closed_at: string; summary: string | null }>,
): string {
  if (rows.length === 0) return '  (no closed sessions yet)';
  return rows
    .map((r) => {
      const first = r.summary ? firstLine(r.summary) : '(no log)';
      return `  ${r.id.slice(0, 8)}  ${localDate(r.closed_at)}  ${first || '(no log)'}`;
    })
    .join('\n');
}

class AmbiguousPrefixError extends Error {
  constructor(public matches: SessionRow[]) {
    super('ambiguous prefix');
  }
}

/** Resolve a CLOSED session by full id or unique prefix. null = not found. */
function resolveByIdArg(
  db: import('../ledger/database.js').Database,
  arg: string,
): Session | null {
  const exact = db.get(
    'SELECT * FROM session WHERE id = ? AND closed_at IS NOT NULL',
    [arg],
  ) as unknown as SessionRow | undefined;
  if (exact) return rowToSession(exact);

  const matches = db.all(
    'SELECT * FROM session WHERE id LIKE ? AND closed_at IS NOT NULL ORDER BY closed_at DESC',
    [arg + '%'],
  ) as unknown as SessionRow[];

  if (matches.length === 1) return rowToSession(matches[0]);
  if (matches.length > 1) throw new AmbiguousPrefixError(matches);
  return null;
}

function gatherRecords(
  db: import('../ledger/database.js').Database,
  sessionId: string,
  type: string,
): RecordRow[] {
  return db.all(
    `SELECT id, type, content_text, tags, created_at FROM record
     WHERE source_session = ? AND type = ?
       AND retracted_at IS NULL AND archived_at IS NULL
     ORDER BY created_at ASC`,
    [sessionId, type],
  ) as unknown as RecordRow[];
}

function renderMarkdown(params: {
  date: string;
  projectName: string;
  slug: string;
  summary: string;
  sessionLogs: RecordRow[];
  decisions: RecordRow[];
  fixes: RecordRow[];
}): string {
  const { date, projectName, slug, summary, sessionLogs, decisions, fixes } = params;
  const parts: string[] = [];

  parts.push(`# ${date} — ${projectName} — ${slug}`);

  // Inline-marker summaries (legacy single-line paragraphs) parse from segments;
  // multi-line summaries keep the line-based parsing.
  const inline = hasInlineMarkers(summary);
  const inlineSegments = inline ? parseInlineSegments(summary.trim()).segments : null;

  const goal = inline
    ? firstSentence(parseInlineSegments(summary.trim()).pre)
    : firstLine(summary);
  if (goal) parts.push(`**Goal**: ${goal}`);

  // Done: every session_log record content, split into bullets.
  const doneBullets: string[] = [];
  for (const log of sessionLogs) {
    doneBullets.push(...logToDoneBullets(log.content_text));
  }
  if (doneBullets.length > 0) {
    parts.push(['**Done**:', ...doneBullets.map((b) => `- ${b}`)].join('\n'));
  }

  if (decisions.length > 0) {
    const bullets = decisions.map((d) => {
      const tags = (JSON.parse(d.tags) as string[]) ?? [];
      const rejected = tags.includes('rejected') ? ' [rejected]' : '';
      const field = extractField(d.content_text, 'Decision', DECISION_FIELDS);
      const body = field ? firstSentence(field) : firstSentence(d.content_text);
      return `- ${body}${rejected}`;
    });
    parts.push(['**Decisions**:', ...bullets].join('\n'));
  }

  if (fixes.length > 0) {
    const bullets = fixes.map((f) => {
      const field = extractField(f.content_text, 'Solution', FIX_FIELDS);
      const body = field ? firstSentence(field) : firstSentence(f.content_text);
      return `- ${body}`;
    });
    parts.push(['**Framework fixes**:', ...bullets].join('\n'));
  }

  let deferred: string[];
  if (inline) {
    const raw = inlineSegments!.get('todos') ?? inlineSegments!.get('deferred');
    deferred = raw ? raw.split(/;\s*/).map((d) => d.trim()).filter(Boolean) : [];
  } else {
    deferred = parseDeferred(summary);
  }
  if (deferred.length > 0) {
    parts.push(['**Deferred to backlog**:', ...deferred.map((d) => `- ${d}`)].join('\n'));
  }

  const next = inline ? inlineSegments!.get('next')?.trim() || null : parseNext(summary);
  if (next) parts.push(`**Next**: ${next}`);

  return parts.join('\n\n') + '\n';
}

export function registerExportSessionCommand(program: Command): void {
  program
    .command('export-session [sessionId]')
    .description('Render one closed session as a markdown session log')
    .option('--latest', 'Export the most recently closed session')
    .option('--out <dir>', 'Output directory (defaults to config memory.export_path)')
    .option('--slug <slug>', 'Override the filename slug')
    .option('--force', 'Overwrite an existing target file')
    .action(
      async (
        sessionId: string | undefined,
        opts: { latest?: boolean; out?: string; slug?: string; force?: boolean },
      ) => {
        const { openDatabase } = await import('../ledger/database.js');
        const { getLastClosedSession } = await import('../ledger/sessions.js');
        const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

        const cwd = process.cwd();
        const projectRoot = findProjectRoot(cwd);
        if (!projectRoot) {
          console.error(
            'No memnant project found in this or any parent directory. Run `memnant init` first.',
          );
          process.exit(1);
        }

        let config;
        try {
          config = loadConfig(projectRoot);
        } catch (err) {
          console.error(err instanceof ConfigError ? err.message : String(err));
          process.exit(1);
        }

        const dbPath = join(projectRoot, config.memory.db_path);
        if (!existsSync(dbPath)) {
          console.error(
            `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
          );
          process.exit(1);
        }

        const db = openDatabase(dbPath);

        try {
          // ── Resolve the session ──────────────────────────────────────
          let session: Session | null = null;

          if (opts.latest) {
            session = getLastClosedSession(db);
            if (!session) {
              console.error('No closed sessions found. Close a session before exporting it.');
              process.exit(1);
            }
          } else if (sessionId) {
            try {
              session = resolveByIdArg(db, sessionId);
            } catch (err) {
              if (err instanceof AmbiguousPrefixError) {
                console.error(`Session id prefix '${sessionId}' is ambiguous. Candidates:`);
                console.error(
                  formatRecentList(
                    err.matches.map((m) => ({
                      id: m.id,
                      closed_at: m.closed_at as string,
                      summary: null,
                    })),
                  ),
                );
                console.error('Provide more characters to disambiguate.');
                process.exit(1);
              }
              throw err;
            }
            if (!session) {
              console.error(`No closed session found matching '${sessionId}'. Recent closed sessions:`);
              console.error(formatRecentList(recentClosed(db, 5)));
              process.exit(1);
            }
          } else {
            console.error(
              'Specify a session id or use --latest. Recent closed sessions:',
            );
            console.error(formatRecentList(recentClosed(db, 5)));
            process.exit(1);
          }

          // ── Gather records ───────────────────────────────────────────
          const sessionLogs = gatherRecords(db, session.id, 'session_log');
          const decisions = gatherRecords(db, session.id, 'decision');
          const fixes = gatherRecords(db, session.id, 'framework_fix');

          // The "summary" is the session's primary log (log_record_id) if that
          // record is still active, else the earliest active session_log.
          const primary =
            sessionLogs.find((r) => r.id === session!.log_record_id) ?? sessionLogs[0];
          const summary = primary?.content_text ?? '';

          // ── Compute filename ─────────────────────────────────────────
          const date = localDate(session.closed_at as string);
          const slug = opts.slug ? slugify(opts.slug) : slugify(firstLine(summary) || `session ${session.id.slice(0, 8)}`);

          const outDir = opts.out
            ? isAbsolute(opts.out)
              ? opts.out
              : resolve(cwd, opts.out)
            : join(projectRoot, config.memory.export_path);

          const target = join(outDir, `${date}-${slug}.md`);

          if (existsSync(target) && !opts.force) {
            console.error(
              `Session log already exists at ${target}. Use --force to overwrite.`,
            );
            process.exit(1);
          }

          const markdown = renderMarkdown({
            date,
            projectName: config.project.name,
            slug,
            summary,
            sessionLogs,
            decisions,
            fixes,
          });

          mkdirSync(outDir, { recursive: true });
          writeFileSync(target, markdown);

          process.stderr.write(`Exported session ${session.id.slice(0, 8)}.\n`);
          console.log(target);
        } finally {
          db.close();
        }
      },
    );
}

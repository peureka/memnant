/**
 * memnant export — Export the ledger to portable formats.
 *
 * Story 1.5: Exports all records as markdown (one file per record, organised
 * by type subdirectory) or as a single JSON file. Supports --since date filtering.
 * Export is a full snapshot — previous files are overwritten.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { VERSION } from '../version.js';
import { join } from 'path';
import { userInfo } from 'os';
import yaml from 'js-yaml';
import type { RecordType } from '../types.js';

const TYPE_SUBDIRS: Record<RecordType, string> = {
  decision: 'decisions',
  session_log: 'session_logs',
  framework_fix: 'framework_fixes',
  spec_snapshot: 'spec_snapshots',
  codebase_snapshot: 'codebase_snapshots',
  orchestrator_task: 'orchestrator_tasks',
  synthesis_cache: 'synthesis_cache',
  governance_override: 'governance_overrides',
  pattern: 'patterns',
};

interface RecordRow {
  id: string;
  type: RecordType;
  content_text: string;
  tags: string;
  related_records: string;
  created_at: string;
}

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export the ledger to markdown or JSON')
    .option('--format <format>', 'Export format: markdown, json, portable, or notebooklm', 'markdown')
    .option('--since <date>', 'Export only records after YYYY-MM-DD')
    .option('--type <type>', 'Export only records of this type')
    .option('--team', 'Export shareable records with builder identity for team sync')
    .action(async (opts: { format: string; since?: string; type?: string; team?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { RECORD_TYPES } = await import('../types.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

      // Validate --format
      if (!['markdown', 'json', 'portable', 'notebooklm'].includes(opts.format) && !opts.team) {
        console.error(
          `Unknown export format '${opts.format}'. Valid formats: markdown, json, portable, notebooklm`,
        );
        process.exit(1);
      }

      // Validate --type
      if (opts.type && !RECORD_TYPES.includes(opts.type as (typeof RECORD_TYPES)[number])) {
        console.error(
          `Unknown record type '${opts.type}'. Valid types: ${RECORD_TYPES.join(', ')}`,
        );
        process.exit(1);
      }

      // Validate --since
      if (opts.since && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
        console.error(
          `Invalid date format '${opts.since}'. Expected YYYY-MM-DD (e.g. 2025-01-01).`,
        );
        process.exit(1);
      }

      // Load project config
      const cwd = process.cwd();
      const projectRoot = findProjectRoot(cwd);
      if (!projectRoot) {
        console.error('No memnant project found in this or any parent directory. Run `memnant init` first.');
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

      let records: RecordRow[];
      try {
        // Query records (exclude retracted and archived)
        let query = 'SELECT id, type, content_text, tags, related_records, created_at FROM record WHERE retracted_at IS NULL AND archived_at IS NULL';
        const params: string[] = [];

        if (opts.since) {
          query += ' AND created_at >= ?';
          params.push(opts.since + 'T00:00:00.000Z');
        }

        if (opts.type) {
          query += ' AND type = ?';
          params.push(opts.type);
        }

        query += ' ORDER BY created_at ASC';

        records = db.all(query, params) as unknown as RecordRow[];
      } finally {
        db.close();
      }

      const exportPath = join(projectRoot, config.memory.export_path);

      if (opts.team) {
        const builderId = config.project.builder ?? process.env.MEMNANT_BUILDER_ID ?? userInfo().username;
        exportTeam(records, exportPath, config.project.name, config.project.id, builderId);
        console.log(`Exported ${records.length} records for team sync to ${config.memory.export_path}`);
        return;
      }

      if (opts.format === 'notebooklm') {
        exportNotebookLM(records, exportPath, config.project.name);
      } else if (opts.format === 'portable') {
        exportPortable(records, exportPath, config.project.name);
      } else if (opts.format === 'json') {
        exportJson(records, exportPath);
      } else {
        exportMarkdown(records, exportPath);
      }

      console.log(`Exported ${records.length} records to ${config.memory.export_path}`);
    });
}

function exportMarkdown(records: RecordRow[], exportPath: string): void {
  // Clear and recreate type subdirectories
  for (const subdir of Object.values(TYPE_SUBDIRS)) {
    const dirPath = join(exportPath, subdir);
    rmSync(dirPath, { recursive: true, force: true });
    mkdirSync(dirPath, { recursive: true });
  }

  for (const record of records) {
    const date = record.created_at.slice(0, 10);
    const shortId = record.id.slice(0, 4);
    const filename = `${date}_${shortId}.md`;

    const tags = JSON.parse(record.tags) as string[];
    const relatedRecords = JSON.parse(record.related_records) as string[];

    const frontmatter = yaml.dump(
      {
        id: record.id,
        type: record.type,
        created_at: record.created_at,
        tags,
        related_records: relatedRecords,
      },
      { lineWidth: -1 },
    ).trim();

    const content = `---\n${frontmatter}\n---\n\n${record.content_text}\n`;

    const subdir = TYPE_SUBDIRS[record.type];
    writeFileSync(join(exportPath, subdir, filename), content);
  }
}

function exportPortable(records: RecordRow[], exportPath: string, projectName: string): void {
  mkdirSync(exportPath, { recursive: true });

  const portablePath = join(exportPath, 'framework-fixes.portable.json');

  const data = {
    memnant_version: VERSION,
    source_project: projectName,
    exported_at: new Date().toISOString(),
    record_count: records.length,
    records: records.map((r) => ({
      type: r.type,
      content_text: r.content_text,
      tags: JSON.parse(r.tags) as string[],
      original_id: r.id,
      created_at: r.created_at,
    })),
  };

  writeFileSync(portablePath, JSON.stringify(data, null, 2) + '\n');
}

const TYPE_LABELS_PLURAL: Record<RecordType, string> = {
  decision: 'Decisions',
  session_log: 'Session Logs',
  framework_fix: 'Framework Fixes',
  spec_snapshot: 'Spec Snapshots',
  codebase_snapshot: 'Codebase Snapshots',
  orchestrator_task: 'Orchestrator Tasks',
  synthesis_cache: 'Synthesis Cache',
  governance_override: 'Governance Overrides',
  pattern: 'Patterns',
};

function exportNotebookLM(records: RecordRow[], exportPath: string, projectName: string): void {
  mkdirSync(exportPath, { recursive: true });

  const filePath = join(exportPath, 'notebooklm.md');
  const lines: string[] = [];

  lines.push(`# ${projectName} — Project Knowledge Ledger`);
  lines.push('');
  lines.push(`Exported from memnant on ${new Date().toISOString().slice(0, 10)}. ${records.length} records.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group by type
  const byType = new Map<RecordType, RecordRow[]>();
  for (const r of records) {
    const group = byType.get(r.type) || [];
    group.push(r);
    byType.set(r.type, group);
  }

  for (const [type, group] of byType) {
    lines.push(`## ${TYPE_LABELS_PLURAL[type]} (${group.length})`);
    lines.push('');

    for (const r of group) {
      const date = r.created_at.slice(0, 10);
      const tags = JSON.parse(r.tags) as string[];
      const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

      lines.push(`### ${date} — ${r.id.slice(0, 8)}${tagStr}`);
      lines.push('');
      lines.push(r.content_text);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  writeFileSync(filePath, lines.join('\n'));
}

function exportJson(records: RecordRow[], exportPath: string): void {
  mkdirSync(exportPath, { recursive: true });

  const jsonPath = join(exportPath, 'export.json');

  const data = records.map((r) => ({
    id: r.id,
    type: r.type,
    content_text: r.content_text,
    tags: JSON.parse(r.tags) as string[],
    related_records: JSON.parse(r.related_records) as string[],
    created_at: r.created_at,
  }));

  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
}

function exportTeam(records: RecordRow[], exportPath: string, projectName: string, projectId: string, builderId: string): void {
  mkdirSync(exportPath, { recursive: true });

  // Filter to shareable types (not snapshots or cache)
  const shareable = records.filter((r) =>
    ['decision', 'framework_fix', 'session_log'].includes(r.type),
  );

  const portablePath = join(exportPath, 'team-export.portable.json');

  const data = {
    memnant_version: VERSION,
    source_project: projectName,
    source_project_id: projectId,
    builder_id: builderId,
    exported_at: new Date().toISOString(),
    record_count: shareable.length,
    records: shareable.map((r) => ({
      type: r.type,
      content_text: r.content_text,
      tags: JSON.parse(r.tags) as string[],
      original_id: r.id,
      created_at: r.created_at,
    })),
  };

  writeFileSync(portablePath, JSON.stringify(data, null, 2) + '\n');
}

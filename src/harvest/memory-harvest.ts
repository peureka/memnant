/**
 * memnant — Claude Code memory harvest orchestrator.
 *
 * Discovers memory files, parses, filters, deduplicates, and inserts
 * relevant records into the appropriate project ledger or colony.
 */

import { join } from 'path';
import { discoverMemorySources, listMemoryFiles } from './memory-discover.js';
import { parseMemoryFile, type ClaudeMemoryFile } from './memory-parser.js';
import { shouldSkipFile, mapMemoryType } from './memory-filter.js';
import { deduplicateAgainstLedger } from './harvest.js';
import type { ExtractedRecord } from './extract.js';
import type { RecordType } from '../types.js';

export interface MemoryHarvestResult {
  sourcesScanned: number;
  filesFound: number;
  filesSkipped: number;
  candidatesExtracted: number;
  recordsWritten: number;
  duplicatesSkipped: number;
  details: Array<{
    file: string;
    action: 'imported' | 'skipped:type' | 'skipped:duplicate' | 'skipped:index' | 'skipped:table-heavy' | 'skipped:no-project';
    memnantType?: RecordType;
    project?: string;
  }>;
}

const DEDUP_THRESHOLD = 0.92;

export async function harvestMemory(options?: {
  dryRun?: boolean;
  projectRoot?: string;
  dedupThreshold?: number;
  quiet?: boolean;
}): Promise<MemoryHarvestResult> {
  const result: MemoryHarvestResult = {
    sourcesScanned: 0,
    filesFound: 0,
    filesSkipped: 0,
    candidatesExtracted: 0,
    recordsWritten: 0,
    duplicatesSkipped: 0,
    details: [],
  };

  const threshold = options?.dedupThreshold ?? DEDUP_THRESHOLD;
  const sources = discoverMemorySources();
  result.sourcesScanned = sources.length;

  // Group candidates by project for batch dedup
  const projectCandidates = new Map<string, {
    projectId: string;
    projectRoot: string;
    dbPath: string;
    candidates: ExtractedRecord[];
    fileNames: string[];
  }>();

  // Colony candidates (no single project match)
  const colonyCandidates: ExtractedRecord[] = [];
  const colonyFileNames: string[] = [];

  for (const source of sources) {
    const files = listMemoryFiles(source.memoryDir);
    result.filesFound += files.length;

    for (const filePath of files) {
      const memory = parseMemoryFile(filePath);
      if (!memory) {
        result.filesSkipped++;
        continue;
      }

      const skipReason = shouldSkipFile(memory);
      if (skipReason) {
        result.filesSkipped++;
        result.details.push({
          file: memory.fileName,
          action: `skipped:${skipReason}` as any,
        });
        continue;
      }

      const mapping = mapMemoryType(memory.type);
      if (!mapping) {
        result.filesSkipped++;
        result.details.push({
          file: memory.fileName,
          action: 'skipped:type',
        });
        continue;
      }

      const candidate: ExtractedRecord = {
        type: mapping.memnantType as 'decision' | 'framework_fix',
        content: memory.content,
        tags: [...mapping.tags, `source-file:${memory.fileName}`],
      };

      result.candidatesExtracted++;

      if (source.registryProject) {
        const key = source.registryProject.id;
        if (!projectCandidates.has(key)) {
          // Resolve DB path
          let dbPath = '.memnant/ledger.db';
          try {
            const { loadConfig } = await import('../config/load.js');
            const config = loadConfig(source.registryProject.root_path);
            dbPath = config.memory.db_path;
          } catch {
            // Use default
          }

          projectCandidates.set(key, {
            projectId: source.registryProject.id,
            projectRoot: source.registryProject.root_path,
            dbPath,
            candidates: [],
            fileNames: [],
          });
        }
        projectCandidates.get(key)!.candidates.push(candidate);
        projectCandidates.get(key)!.fileNames.push(memory.fileName);
      } else {
        colonyCandidates.push(candidate);
        colonyFileNames.push(memory.fileName);
      }
    }
  }

  if (options?.dryRun) {
    // In dry-run mode, report what would happen without writing
    for (const [, proj] of projectCandidates) {
      for (let i = 0; i < proj.candidates.length; i++) {
        result.details.push({
          file: proj.fileNames[i],
          action: 'imported',
          memnantType: proj.candidates[i].type,
          project: proj.projectRoot.split('/').pop(),
        });
      }
    }
    for (let i = 0; i < colonyCandidates.length; i++) {
      result.details.push({
        file: colonyFileNames[i],
        action: 'imported',
        memnantType: colonyCandidates[i].type,
        project: 'colony',
      });
    }
    result.recordsWritten = result.candidatesExtracted;
    return result;
  }

  // Write to project ledgers
  for (const [, proj] of projectCandidates) {
    const { openDatabase } = await import('../ledger/database.js');
    const { insertRecord } = await import('../ledger/records.js');
    const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');
    const { autoLinkRecord } = await import('../graph/relationships.js');

    const fullDbPath = join(proj.projectRoot, proj.dbPath);
    let db;
    try {
      db = openDatabase(fullDbPath);
    } catch {
      // Can't open DB, skip this project
      for (const fileName of proj.fileNames) {
        result.details.push({ file: fileName, action: 'skipped:no-project' });
        result.filesSkipped++;
      }
      continue;
    }

    try {
      const unique = await deduplicateAgainstLedger(db, proj.candidates, threshold);
      const duplicateCount = proj.candidates.length - unique.length;
      result.duplicatesSkipped += duplicateCount;

      // Mark duplicates in details
      const uniqueContents = new Set(unique.map((u) => u.content));
      for (let i = 0; i < proj.candidates.length; i++) {
        if (!uniqueContents.has(proj.candidates[i].content)) {
          result.details.push({
            file: proj.fileNames[i],
            action: 'skipped:duplicate',
            memnantType: proj.candidates[i].type,
          });
        }
      }

      for (let i = 0; i < unique.length; i++) {
        const record = unique[i];
        const embedding = await generateEmbedding(record.content);

        const inserted = insertRecord(db, {
          projectId: proj.projectId,
          type: record.type,
          contentText: record.content,
          embedding: serializeEmbedding(embedding),
          tags: record.tags,
          sourceSession: null,
        });

        try {
          const { loadConfig } = await import('../config/load.js');
          const config = loadConfig(proj.projectRoot);
          // Override embedding with Float32Array for auto-linking
          autoLinkRecord(db, { ...inserted, embedding } as any, config);
        } catch {
          // Auto-link is best-effort
        }

        // Find which original file this unique record corresponds to
        const originalIdx = proj.candidates.findIndex((c) => c.content === record.content);
        if (originalIdx !== -1) {
          result.details.push({
            file: proj.fileNames[originalIdx],
            action: 'imported',
            memnantType: record.type,
            project: proj.projectRoot.split('/').pop(),
          });
        }

        result.recordsWritten++;
      }
    } finally {
      db.close();
    }
  }

  // Write colony candidates
  if (colonyCandidates.length > 0) {
    try {
      const { openColonyDb } = await import('../colony/colony.js');
      const { insertRecord } = await import('../ledger/records.js');
      const { generateEmbedding, serializeEmbedding } = await import('../vector/embeddings.js');

      const colonyDb = openColonyDb();
      const unique = await deduplicateAgainstLedger(colonyDb, colonyCandidates, threshold);
      result.duplicatesSkipped += colonyCandidates.length - unique.length;

      for (const record of unique) {
        const embedding = await generateEmbedding(record.content);

        insertRecord(colonyDb, {
          projectId: 'colony',
          type: record.type,
          contentText: record.content,
          embedding: serializeEmbedding(embedding),
          tags: [...record.tags, 'from:workspace-memory'],
          sourceSession: null,
        });

        result.recordsWritten++;
      }

      // Mark colony imports in details
      const uniqueContents = new Set(unique.map((u) => u.content));
      for (let i = 0; i < colonyCandidates.length; i++) {
        result.details.push({
          file: colonyFileNames[i],
          action: uniqueContents.has(colonyCandidates[i].content) ? 'imported' : 'skipped:duplicate',
          memnantType: colonyCandidates[i].type,
          project: 'colony',
        });
      }

      colonyDb.close();
    } catch {
      // Colony write is best-effort
      for (const fileName of colonyFileNames) {
        result.details.push({ file: fileName, action: 'skipped:no-project' });
      }
    }
  }

  return result;
}

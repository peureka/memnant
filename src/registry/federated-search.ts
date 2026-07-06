/**
 * memnant — Federated search across multiple project ledgers.
 *
 * Opens each project's database, runs relevance search, merges and re-ranks results.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { openDatabase } from '../ledger/database.js';
import { generateEmbedding } from '../vector/embeddings.js';
import { relevanceSearch } from '../relevance/search.js';
import type { ScoredRecord } from '../relevance/scoring.js';
import type { ProjectConfig } from '../types.js';
import { loadConfig } from '../config/load.js';

export interface FederatedProject {
  name: string;
  root_path: string;
  db_path: string;
}

export interface FederatedResult extends ScoredRecord {
  source_project: string;
}

export interface FederatedSearchOptions {
  limit?: number;
  type?: string;
  since?: string;
}

/**
 * Search across multiple project ledgers.
 *
 * Generates the query embedding once, then opens each project's DB,
 * runs relevance search, and merges results sorted by relevance.
 */
export async function federatedSearch(
  query: string,
  projects: FederatedProject[],
  options?: FederatedSearchOptions,
): Promise<FederatedResult[]> {
  if (projects.length === 0) return [];

  const queryEmbedding = await generateEmbedding(query);
  const allResults: FederatedResult[] = [];

  for (const project of projects) {
    const dbPath = join(project.root_path, project.db_path);
    if (!existsSync(dbPath)) continue;

    let decayProfile: string | undefined;
    let weights: ProjectConfig['memory']['relevance_weights'];

    try {
      const config = loadConfig(project.root_path);
      decayProfile = config.memory.decay_profile;
      weights = config.memory.relevance_weights;
    } catch {
      // Use defaults
    }

    try {
      const db = openDatabase(dbPath);
      const results = await relevanceSearch(db, queryEmbedding, {
        limit: options?.limit ?? 10,
        projectRoot: project.root_path,
        type: options?.type as any,
        since: options?.since,
        decayProfile,
        weights,
      });

      for (const r of results) {
        allResults.push({
          ...r,
          source_project: project.name,
        });
      }

      db.close();
    } catch {
      // Skip failed projects silently
      continue;
    }
  }

  // Re-rank by relevance score and take top N
  allResults.sort((a, b) => b.relevance - a.relevance);
  return allResults.slice(0, options?.limit ?? 10);
}

/**
 * Resolve registered projects to FederatedProject entries.
 */
export function resolveProjects(
  projectNames: string[] | undefined,
  registryProjects: Array<{ name: string; root_path: string }>,
): FederatedProject[] {
  const targets = projectNames
    ? registryProjects.filter((p) => projectNames.some((n) => p.name.toLowerCase().startsWith(n.toLowerCase())))
    : registryProjects;

  return targets.map((p) => {
    let dbPath = '.memnant/ledger.db';
    try {
      const config = loadConfig(p.root_path);
      dbPath = config.memory.db_path;
    } catch {
      // Use default
    }

    return { name: p.name, root_path: p.root_path, db_path: dbPath };
  });
}

/**
 * Harvest watermark sidecar.
 *
 * Records which transcript files have already been processed, keyed by
 * absolute path → { mtime, size }. Lives at `.memnant/harvest-state.json`
 * inside the project's ledger dir (machine-local, like the transcript paths
 * it references). Not a DB table — no schema migration.
 *
 * A corrupt or missing state file is treated as "no watermark" (full
 * harvest); it never throws.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export interface WatermarkEntry {
  mtime: number;
  size: number;
}

export type HarvestState = Record<string, WatermarkEntry>;

export function getStatePath(projectRoot: string): string {
  return join(projectRoot, '.memnant', 'harvest-state.json');
}

export function readHarvestState(statePath: string): HarvestState {
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HarvestState;
    }
    return {};
  } catch {
    return {};
  }
}

export function writeHarvestState(statePath: string, state: HarvestState): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: the watermark is an optimisation, never a correctness gate.
  }
}

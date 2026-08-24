/**
 * memnant — Re-stamp a project's orchestrator tier pins from the scaffold.
 *
 * `memnant init` copies src/config/defaults.ts into each project's memnant.yaml,
 * after which the two have no relationship. Correcting the scaffold therefore
 * fixes new projects only, and every existing project silently keeps whatever
 * model generation it was created with.
 *
 * Only the tier `model:` lines are owned by the scaffold. `max_context_tokens`,
 * provider overrides, interfaces and everything else are the project's own, and
 * are left alone.
 */

export interface TierChange {
  tier: string;
  from: string;
  to: string;
}

export interface MigrationPlan {
  changes: TierChange[];
  updated: string;
}

/**
 * Work out which tier pins have drifted from the scaffold, and produce the
 * rewritten file.
 *
 * Rewrites targeted lines rather than round-tripping through a YAML parser: a
 * round-trip would reformat the document and discard comments, turning a
 * three-line correction into an unreviewable diff.
 */
export function planTierMigration(
  raw: string,
  targets: Record<string, string>,
): MigrationPlan {
  const lines = raw.split('\n');
  const changes: TierChange[] = [];

  let inTiers = false;
  let tier: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/^ {2}tiers:\s*$/.test(line)) {
      inTiers = true;
      tier = null;
      continue;
    }

    // Any key back at two-space indent ends the tiers block.
    if (inTiers && /^ {2}\S/.test(line)) {
      inTiers = false;
      tier = null;
    }

    if (!inTiers) continue;

    const tierHeading = line.match(/^ {4}(\w+):\s*$/);
    if (tierHeading) {
      tier = tierHeading[1]!;
      continue;
    }

    const modelLine = line.match(/^( {6}model:\s*)(\S+)\s*$/);
    if (!modelLine || !tier) continue;

    const target = targets[tier];
    if (!target) continue; // a tier the scaffold does not own

    const current = modelLine[2]!;
    if (current === target) continue;

    changes.push({ tier, from: current, to: target });
    lines[i] = modelLine[1] + target;
  }

  return { changes, updated: lines.join('\n') };
}

/**
 * The tier pins the current scaffold stamps, as a plain tier -> model map.
 */
export function scaffoldTierTargets(
  tiers: Record<string, { model: string }>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(tiers).map(([name, t]) => [name, t.model]));
}

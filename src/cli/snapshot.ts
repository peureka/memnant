/**
 * memnant snapshot — Codebase snapshot commands.
 *
 * Story 3.1: Takes structural snapshots of the codebase for staleness detection.
 * Story 3.3: --auto flag for git hook integration.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  scanProject,
  diffSnapshots,
  buildSummaryText,
  getLastSnapshot,
  getLastSnapshotDate,
} from '../snapshot/scanner.js';

export function registerSnapshotCommand(program: Command): void {
  program
    .command('snapshot')
    .description('Take a structural snapshot of the codebase')
    .option('--diff', 'Show changes since last snapshot without creating a new one')
    .option('--auto', 'Only snapshot if the last one is over 24 hours old (for git hooks)')
    .action(async (opts: { diff?: boolean; auto?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { detectSpecDrift } = await import('../governor/drift.js');
      const { loadConfig, ConfigError, findProjectRoot } = await import('../config/load.js');

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

      try {
        const oldSnapshot = getLastSnapshot(db);

        // --auto: skip if last snapshot is less than 24 hours old
        if (opts.auto) {
          const lastDate = getLastSnapshotDate(db);
          if (lastDate) {
            const hoursSince = (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60);
            if (hoursSince < 24) {
              console.log(`Last snapshot is ${Math.round(hoursSince)}h old. Skipping (< 24h).`);
              return;
            }
          }
        }

        // Scan current state
        const newSnapshot = scanProject(projectRoot);
        const diff = diffSnapshots(oldSnapshot, newSnapshot);
        const summaryText = buildSummaryText(newSnapshot, diff);

        // --diff: just output the diff
        if (opts.diff) {
          if (diff.modified.length === 0 && diff.added.length === 0 && diff.removed.length === 0 &&
              diff.dep_added.length === 0 && diff.dep_removed.length === 0 && diff.dep_changed.length === 0) {
            console.log('No changes since last snapshot.');
            return;
          }

          console.log(summaryText);
          console.log('');

          if (diff.modified.length > 0) {
            console.log('Modified:');
            for (const p of diff.modified) {
              console.log(`  ${p}`);
            }
          }
          if (diff.added.length > 0) {
            console.log('Added:');
            for (const p of diff.added) {
              console.log(`  ${p}`);
            }
          }
          if (diff.removed.length > 0) {
            console.log('Removed:');
            for (const p of diff.removed) {
              console.log(`  ${p}`);
            }
          }
          if (diff.dep_added.length > 0) {
            console.log('Dependencies added:');
            for (const d of diff.dep_added) {
              console.log(`  ${d}`);
            }
          }
          if (diff.dep_removed.length > 0) {
            console.log('Dependencies removed:');
            for (const d of diff.dep_removed) {
              console.log(`  ${d}`);
            }
          }
          if (diff.dep_changed.length > 0) {
            console.log('Dependencies changed:');
            for (const d of diff.dep_changed) {
              console.log(`  ${d.name}: ${d.from} → ${d.to}`);
            }
          }
          return;
        }

        // Create snapshot record (shared with session-start auto-snapshot)
        const { takeCodebaseSnapshot } = await import('../snapshot/take.js');
        const result = await takeCodebaseSnapshot(
          db,
          config.project.id,
          projectRoot,
          config.memory.max_codebase_snapshots,
        );

        console.log(`Snapshot ${result.recordId.slice(0, 8)} created.`);
        console.log(result.summaryText);
        if (result.pruned > 0) {
          console.log(`Pruned ${result.pruned} old snapshot(s).`);
        }

        // Story 13.3: Spec drift detection on changed files
        const changedFiles = [...diff.modified, ...diff.added];
        if (changedFiles.length > 0) {
          const docsPath = join(projectRoot, config.governor.docs_path);
          const driftResult = detectSpecDrift(changedFiles, projectRoot, docsPath);
          if (driftResult.total_violations > 0) {
            console.log('');
            console.log(`Spec drift detected: ${driftResult.total_violations} violation(s) in changed files.`);
            for (const cv of driftResult.copy_violations) {
              for (const v of cv.violations) {
                console.log(`  ${cv.file}${v.line ? `:${v.line}` : ''} ${v.message}`);
              }
            }
            for (const dv of driftResult.design_violations) {
              for (const v of dv.violations) {
                console.log(`  ${dv.file}:${v.line} ${v.message}`);
              }
            }
          }
        }
      } finally {
        db.close();
      }
    });
}

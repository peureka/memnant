#!/usr/bin/env node

/**
 * memnant — The context layer for agent-operated products.
 *
 * This is the CLI entry point. Each command is implemented in its own file
 * under src/cli/ and registered here.
 *
 * Visible commands (~11) are shown in --help.
 * Hidden commands still work but don't clutter the help output.
 */

import { Command } from 'commander';
import { VERSION } from '../version.js';
import { registerInitCommand } from './init.js';
import { registerStatusCommand } from './status.js';
import { registerLogCommand } from './log.js';
import { registerRecallCommand } from './recall.js';
import { registerServeCommand } from './serve.js';
import { registerExportCommand } from './export.js';
import { registerSessionCommand } from './session.js';
import { registerSnapshotCommand } from './snapshot.js';
import { registerCheckCopyCommand } from './check-copy.js';
import { registerCheckDesignCommand } from './check-design.js';
import { registerLintCommand } from './lint.js';
import { registerSetupCommand } from './setup.js';
import { registerInstructionsCommand } from './instructions.js';
import { registerGraphCommand } from './graph.js';
import { registerSynthesiseCommand } from './synthesise.js';
import { registerHealthCommand } from './health.js';
import { registerRetractCommand } from './retract.js';
import { registerArchiveCommand } from './archive.js';
import { registerStatsCommand } from './stats.js';
import { registerImportCommand } from './import.js';
import { registerReindexCommand } from './reindex.js';
import { registerReplayCommand } from './replay.js';
import { registerSpecDiffCommand } from './spec-diff.js';
import { registerEvalPersonaCommand } from './eval-persona.js';
import { registerProjectsCommand } from './projects.js';
import { registerSearchCommand } from './federated-search.js';
import { registerIngestCommand } from './ingest.js';
import { registerCostsCommand } from './costs.js';
import { registerPromoteCommand } from './promote.js';
import { registerHarvestCommand } from './harvest.js';
import { registerObserveCommand } from './observe.js';
import { registerHistoryCommand } from './history.js';
import { registerAnalyticsCommand } from './analytics.js';
import { registerTeamCommand } from './team.js';
import { registerBriefCommand } from './brief.js';
import { registerDoctorCommand } from './doctor.js';
import { registerWorkspaceCommand } from './workspace.js';
import { registerHarvestMemoryCommand } from './harvest-memory.js';
import { defaultAction } from './default-action.js';
import { checkForUpdate } from './update-check.js';

const program = new Command();

program
  .name('memnant')
  .description('The context layer for agent-operated products')
  .version(VERSION)
  .addHelpText('before', `
Usage: npx memnant

  Run with no arguments to start. memnant auto-detects what to do:
  - New project  → guided setup
  - No session   → start session with compiled context
  - In session   → show session status

`)
  .action(async () => {
    await defaultAction();
  });

// ── Visible commands (shown in --help) ──────────────────────────────
registerInitCommand(program);
registerStatusCommand(program);
registerExportCommand(program);
registerServeCommand(program);
registerRetractCommand(program);
registerArchiveCommand(program);
registerReindexCommand(program);
registerSnapshotCommand(program);
registerPromoteCommand(program);
registerHarvestCommand(program);
registerAnalyticsCommand(program);
registerTeamCommand(program);
registerBriefCommand(program);
registerDoctorCommand(program);
registerWorkspaceCommand(program);
registerHarvestMemoryCommand(program);

// ── Hidden commands (still work, not in --help) ─────────────────────
registerLogCommand(program);
registerRecallCommand(program);
registerSessionCommand(program);
registerSynthesiseCommand(program);
registerCheckCopyCommand(program);
registerCheckDesignCommand(program);
registerEvalPersonaCommand(program);
registerCostsCommand(program);
registerLintCommand(program);
registerImportCommand(program);
registerIngestCommand(program);
registerStatsCommand(program);
registerReplayCommand(program);
registerSpecDiffCommand(program);
registerSearchCommand(program);
registerGraphCommand(program);
registerInstructionsCommand(program);
registerSetupCommand(program);
registerProjectsCommand(program);
registerHealthCommand(program);
registerObserveCommand(program);
registerHistoryCommand(program);

// Mark hidden commands
const hiddenCommands = [
  'log', 'recall', 'session', 'synthesise', 'synthesize',
  'check-copy', 'check-design', 'eval-persona', 'costs',
  'lint', 'import', 'ingest', 'stats', 'replay', 'spec-diff',
  'search', 'graph', 'unsupersede', 'dismiss-contradiction',
  'instructions', 'setup', 'projects', 'health', 'observe', 'history',
];

for (const cmd of program.commands) {
  if (hiddenCommands.includes(cmd.name())) {
    (cmd as unknown as { _hidden: boolean })._hidden = true;
  }
}

checkForUpdate();
program.parse();

/**
 * memnant eval-persona — Persona evaluation runner.
 *
 * Evaluates session work against persona test questions using LLM analysis.
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY.
 */

import { Command } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';

export function registerEvalPersonaCommand(program: Command): void {
  program
    .command('eval-persona')
    .description('Evaluate persona test questions using LLM analysis')
    .option('--session <id>', 'Evaluate a specific session (prefix match)')
    .option('--json', 'Output results as JSON')
    .option('--list', 'List persona test questions without running evaluation')
    .action(async (opts: { session?: string; json?: boolean; list?: boolean }) => {
      const { openDatabase } = await import('../ledger/database.js');
      const { getActiveSession } = await import('../ledger/sessions.js');
      const { evaluatePersonas, getPersonaQuestions } = await import('../governor/persona-eval.js');
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

      const docsPath = join(projectRoot, config.governor.docs_path);

      // List mode — no database needed
      if (opts.list) {
        const questions = getPersonaQuestions(docsPath);
        if (questions.length === 0) {
          console.log(`No persona test questions found in ${config.governor.docs_path}. Create persona docs with type: persona frontmatter and ## Test Questions.`);
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(questions, null, 2));
        } else {
          for (const q of questions) {
            console.log(`${q.persona}: ${q.question}`);
          }
        }
        return;
      }

      if (!existsSync(dbPath)) {
        console.error(
          `Ledger database not found at ${config.memory.db_path}. Run \`memnant init\` to recreate.`,
        );
        process.exit(1);
      }

      const db = openDatabase(dbPath);

      try {
        // Find session
        let sessionId: string;

        if (opts.session) {
          const row = db.get(
            'SELECT id FROM session WHERE id LIKE ?',
            [`${opts.session}%`],
          ) as unknown as { id: string } | undefined;

          if (!row) {
            console.error(`No session found matching '${opts.session}'.`);
            process.exit(1);
          }
          sessionId = row.id;
        } else {
          const active = getActiveSession(db, config.project.id);
          if (!active) {
            console.error('No active session. Use --session <id> to evaluate a specific session.');
            process.exit(1);
          }
          sessionId = active.id;
        }

        const results = await evaluatePersonas(db, config, {
          sessionId,
          projectRoot,
        });

        if (results.length === 0) {
          console.log(
            'No evaluation results. Check that:\n' +
            `  - Persona docs exist in ${config.governor.docs_path} with type: persona frontmatter\n` +
            '  - The session has work records (decisions, framework fixes, etc.)\n' +
            '  - ANTHROPIC_API_KEY or OPENAI_API_KEY is set',
          );
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          for (const r of results) {
            console.log(`${r.persona}: ${r.result} (${r.confidence}) — ${r.question}`);
            console.log(`  ${r.rationale}`);
          }
        }
      } finally {
        db.close();
      }
    });
}

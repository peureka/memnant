/**
 * memnant doctor — Infrastructure diagnostics.
 *
 * Checks all registered projects for common failure modes:
 * missing dist, missing ledger, broken MCP config, stale builds.
 * Complements the existing `health` command which checks ledger content.
 */

import { Command } from 'commander';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check infrastructure health across all memnant projects')
    .option('--fix', 'Attempt to auto-repair fixable issues')
    .option('--json', 'Output as JSON')
    .option('--project <name>', 'Check only a specific project')
    .action(async (opts: { fix?: boolean; json?: boolean; project?: string }) => {
      const { diagnoseAll } = await import('../doctor/diagnose.js');
      const report = diagnoseAll(opts.project);

      if (opts.fix) {
        const { repairAll } = await import('../doctor/repair.js');
        const fixable = report.findings.filter((f) => f.fixable);

        if (fixable.length === 0) {
          if (opts.json) {
            process.stdout.write(JSON.stringify({ ...report, repairs: [] }, null, 2) + '\n');
          } else {
            console.log('No fixable issues found.');
          }
          return;
        }

        const repairs = repairAll(report.findings);

        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...report, repairs }, null, 2) + '\n');
        } else {
          console.log('Repairs:');
          for (const r of repairs) {
            const icon = r.success ? 'OK' : 'FAIL';
            console.log(`  [${icon}] ${r.code}: ${r.message}`);
          }
        }
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return;
      }

      // Text output
      console.log(`memnant doctor — checking ${report.projects_checked} projects\n`);

      // Group findings by project
      const globalFindings = report.findings.filter((f) => !f.project);
      const projectFindings = new Map<string, typeof report.findings>();

      for (const f of report.findings) {
        if (f.project) {
          if (!projectFindings.has(f.project)) {
            projectFindings.set(f.project, []);
          }
          projectFindings.get(f.project)!.push(f);
        }
      }

      // Show per-project results
      const { loadRegistry } = await import('../registry/registry.js');
      const registry = loadRegistry();
      const checkedProjects = opts.project
        ? registry.projects.filter((p) => p.name.toLowerCase().startsWith(opts.project!.toLowerCase()))
        : registry.projects;

      for (const project of checkedProjects) {
        const findings = projectFindings.get(project.name);
        if (!findings || findings.length === 0) {
          console.log(`[OK] ${project.name}`);
        } else {
          const hasErrors = findings.some((f) => f.severity === 'error');
          const icon = hasErrors ? 'XX' : '!!';
          console.log(`[${icon}] ${project.name}`);
          for (const f of findings) {
            console.log(`  - ${f.code}: ${f.message}`);
          }
        }
      }

      // Show global results
      if (globalFindings.length > 0) {
        console.log('\nGlobal:');
        for (const f of globalFindings) {
          const icon = f.severity === 'error' ? 'XX' : f.severity === 'warning' ? '!!' : 'OK';
          console.log(`  [${icon}] ${f.code}: ${f.message}`);
        }
      } else {
        console.log('\nGlobal: [OK]');
      }

      // Summary
      const fixableCount = report.findings.filter((f) => f.fixable).length;
      if (report.findings.length > 0) {
        console.log(`\n${report.findings.length} finding(s)${fixableCount > 0 ? ` (${fixableCount} fixable). Run \`memnant doctor --fix\` to auto-repair.` : '.'}`);
      } else {
        console.log('\nAll clear.');
      }
    });
}

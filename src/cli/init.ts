/**
 * memnant init — Project initialisation command.
 *
 * Story 1.1: Creates memnant.yaml and .memnant/ledger.db.
 * Story 6.2: Interactive init flow for TTY sessions.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { createInterface } from 'readline';
import yaml from 'js-yaml';

const STARTER_COPY_STYLE = `---
type: copy_audit
applies_to: all
---
## Banned Phrases
- "leverage" — use "use"
- "utilize" — use "use"

## Discouraged Phrases
- "please" — unnecessary filler
- "simple" — subjective, often wrong
`;

const STARTER_DESIGN_SYSTEM = `---
type: design_system
applies_to: all
---
## Banned Components
- \`<marquee>\` — deprecated HTML element
- \`<blink>\` — deprecated HTML element

## Approved Components
- Use semantic HTML elements
`;

const STARTER_PERSONA = `---
type: persona
name: Default User
role: Primary user of this product
---
## Test Questions
- Can I complete the core task in under 2 minutes?
- Is the error message helpful when something goes wrong?
- Would I recommend this to a colleague?
`;

export function scaffoldSpecs(cwd: string): void {
  const docsDir = join(cwd, 'docs');
  try {
    mkdirSync(docsDir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create docs/ directory: ${msg}`);
  }

  const specs: Array<{ filename: string; content: string }> = [
    { filename: 'copy-style.md', content: STARTER_COPY_STYLE },
    { filename: 'design-system.md', content: STARTER_DESIGN_SYSTEM },
    { filename: 'persona-user.md', content: STARTER_PERSONA },
  ];

  for (const spec of specs) {
    const specPath = join(docsDir, spec.filename);
    if (!existsSync(specPath)) {
      try {
        writeFileSync(specPath, spec.content, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Could not write docs/${spec.filename}: ${msg}`);
      }
    }
  }

  console.log('Created starter specs in docs/. Edit them to match your project.');
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function initProject(projectName: string, cwd: string): Promise<void> {
  const { createDefaultConfig } = await import('../config/defaults.js');
  const { createDatabase } = await import('../ledger/database.js');

  const configPath = join(cwd, 'memnant.yaml');
  const projectId = uuidv4();
  const config = createDefaultConfig(projectName, projectId);

  try {
    writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not write memnant.yaml: ${msg}`);
  }

  const dbPath = join(cwd, config.memory.db_path);
  let db;
  try {
    db = createDatabase(dbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create database at ${config.memory.db_path}: ${msg}`);
  }

  try {
    db.run(
      'INSERT INTO project (id, name, root_path, created_at) VALUES (?, ?, ?, ?)',
      [projectId, projectName, cwd, new Date().toISOString()],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not write project record to database: ${msg}`);
  } finally {
    db.close();
  }

  // Auto-register in machine-local registry
  try {
    const { loadRegistry, addProject, saveRegistry } = await import('../registry/registry.js');
    const reg = loadRegistry();
    addProject(reg, { id: projectId, name: projectName, root_path: cwd });
    saveRegistry(undefined, reg);
  } catch {
    // Registry is optional — don't fail init
  }
}

async function interactiveInit(cwd: string): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // 1. Project name
    const defaultName = basename(cwd);
    const nameAnswer = await prompt(rl, `Project name (${defaultName}): `);
    const projectName = nameAnswer || defaultName;

    // 2. Init the project
    try {
      await initProject(projectName, cwd);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return;
    }
    console.log(`\nInitialised memnant project "${projectName}".`);

    // 3. Auto-detect and configure agents
    const { autoConfigureAgents } = await import('./setup.js');
    autoConfigureAgents();

    // 4. Starter specs
    const specsAnswer = await prompt(rl, 'Create starter spec documents? (y/N): ');
    if (specsAnswer.toLowerCase() === 'y' || specsAnswer.toLowerCase() === 'yes') {
      console.log('');
      scaffoldSpecs(cwd);
    }

    // 5. Done
    console.log('');
    console.log('Add `.memnant/` to your .gitignore — the ledger is local, not version controlled.');
    console.log('');
    console.log("You're set. Run `npx memnant` to start your first session.");
  } finally {
    rl.close();
  }
}

async function nonInteractiveInit(cwd: string, opts: { withSpecs?: boolean }): Promise<void> {
  const configPath = join(cwd, 'memnant.yaml');

  if (existsSync(configPath)) {
    console.log('memnant is already initialised in this project.');
    return;
  }

  const projectName = basename(cwd);
  try {
    await initProject(projectName, cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return;
  }

  console.log(`Initialised memnant project "${projectName}"`);
  console.log(`Created: memnant.yaml`);
  console.log(`Created: .memnant/ledger.db`);
  console.log('');

  // Auto-detect and configure agents
  const { autoConfigureAgents } = await import('./setup.js');
  autoConfigureAgents();

  console.log('');
  console.log(
    'Add `.memnant/` to your .gitignore — the ledger is local, not version controlled.',
  );

  if (opts.withSpecs) {
    console.log('');
    scaffoldSpecs(cwd);
  }
}

function getGitUserName(cwd: string): string | null {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

async function configureTeamMode(cwd: string, configPath: string): Promise<void> {
  const configContent = readFileSync(configPath, 'utf-8');
  const config = yaml.load(configContent) as any;

  let builder = getGitUserName(cwd);
  if (!builder && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    builder = await prompt(rl, 'Builder name (for team attribution): ') || null;
    rl.close();
  }

  if (builder) {
    config.project.builder = builder;
    writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }), 'utf-8');
  }

  const gitignorePath = join(cwd, '.gitignore');
  const entry = '.memnant/ledger.db';
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes(entry)) {
      const separator = content.endsWith('\n') ? '' : '\n';
      writeFileSync(gitignorePath, content + separator + entry + '\n', 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, entry + '\n', 'utf-8');
  }

  console.log('');
  console.log(`Team mode configured${builder ? ` for builder "${builder}"` : ''}.`);
  console.log('Run `git add .memnant/shared/` after your first session close.');
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialise memnant in the current project')
    .option('--with-specs', 'Scaffold starter spec documents in docs/')
    .option('--non-interactive', 'Skip interactive prompts (for CI/scripts)')
    .option('--team', 'Configure for team use (sets builder identity, updates .gitignore)')
    .action(async (opts: { withSpecs?: boolean; nonInteractive?: boolean; team?: boolean }) => {
      const cwd = process.cwd();
      const configPath = join(cwd, 'memnant.yaml');

      if (existsSync(configPath)) {
        console.log('memnant is already initialised in this project.');
        return;
      }

      const isInteractive = process.stdin.isTTY && !opts.nonInteractive;

      if (isInteractive) {
        await interactiveInit(cwd);
      } else {
        await nonInteractiveInit(cwd, opts);
      }

      // Team mode configuration (after project is initialized)
      if (opts.team && existsSync(configPath)) {
        await configureTeamMode(cwd, configPath);
      }
    });
}

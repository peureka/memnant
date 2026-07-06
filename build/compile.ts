/**
 * memnant — Cross-platform build script.
 *
 * Uses Bun's build API to compile memnant for all targets.
 * Stubs out onnxruntime-node and sharp (native modules that can't be bundled).
 */

import { join, resolve } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const ROOT = resolve(import.meta.dir, '..');
const STUB_DIR = join(ROOT, 'build');
const OUT_DIR = join(ROOT, 'build', 'bin');

const targets = [
  { name: 'memnant-darwin-arm64', target: 'bun-darwin-arm64' },
  { name: 'memnant-darwin-x64', target: 'bun-darwin-x64' },
  { name: 'memnant-linux-arm64', target: 'bun-linux-arm64' },
  { name: 'memnant-linux-x64', target: 'bun-linux-x64' },
  { name: 'memnant-win-arm64.exe', target: 'bun-windows-arm64' },
  { name: 'memnant-win-x64.exe', target: 'bun-windows-x64' },
] as const;

const stubPlugin = {
  name: 'native-stubs',
  setup(build: any) {
    build.onResolve({ filter: /^onnxruntime-node$/ }, () => ({
      path: join(STUB_DIR, 'onnxruntime-node-stub.js'),
      namespace: 'file',
    }));
    build.onResolve({ filter: /^sharp$/ }, () => ({
      path: join(STUB_DIR, 'sharp-stub.js'),
      namespace: 'file',
    }));
  },
};

function findBun(): string {
  // Try common locations
  const candidates = [
    join(process.env.HOME ?? '', '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/usr/bin/bun',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back to PATH lookup
  try {
    return execSync('which bun', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('bun not found. Install from https://bun.sh');
  }
}

async function buildAll() {
  mkdirSync(OUT_DIR, { recursive: true });
  const bunPath = findBun();

  // First, bundle to a single JS file
  const bundleResult = await Bun.build({
    entrypoints: [join(ROOT, 'dist', 'cli', 'index.js')],
    outdir: join(ROOT, 'build', 'bundle'),
    target: 'bun',
    packages: 'bundle',
    plugins: [stubPlugin],
  });

  if (!bundleResult.success) {
    console.error('Bundle failed:', bundleResult.logs);
    process.exit(1);
  }

  console.log('Bundle complete');

  const selectedTarget = process.argv[2];

  for (const { name, target } of targets) {
    if (selectedTarget && !name.includes(selectedTarget)) continue;

    console.log(`Compiling ${name}...`);
    const proc = Bun.spawn([
      bunPath, 'build', '--compile',
      `--target=${target}`,
      '--minify',
      join(ROOT, 'build', 'bundle', 'index.js'),
      '--outfile', join(OUT_DIR, name),
    ], { stdout: 'inherit', stderr: 'inherit' });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error(`Failed to compile ${name}`);
      process.exit(1);
    }
    console.log(`  → ${name} done`);
  }

  console.log('\nAll builds complete. Output in build/bin/');
}

buildAll();

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Injected by build/compile.ts via Bun.build `define` — compiled binaries
 * have no package.json on disk ($bunfs), so the version must be embedded
 * at bundle time. The npm/dist path falls through to reading package.json,
 * which ships in the published package.
 */
declare const __MEMNANT_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof __MEMNANT_VERSION__ === 'string') return __MEMNANT_VERSION__;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  return pkg.version;
}

export const VERSION: string = resolveVersion();

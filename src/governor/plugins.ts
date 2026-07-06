/**
 * memnant — Spec validator plugin system.
 *
 * Config-driven custom validators that plug into `memnant lint`.
 * Plugins are project-local JS/TS files that export a SpecValidator.
 */

import { join } from 'path';
import { pathToFileURL } from 'url';
import type { SpecDetail } from './specs.js';

export interface Violation {
  file?: string;
  line?: number;
  message: string;
  severity: 'banned' | 'discouraged' | 'warning';
  suggestion?: string;
}

export interface SpecValidator {
  name: string;
  specTypes: string[];
  validate(content: string, specDetail: SpecDetail): Violation[];
}

export interface PluginConfig {
  enabled: boolean;
  script: string;
}

/**
 * Load validator plugins from config.
 */
export async function loadPlugins(
  pluginsConfig: Record<string, PluginConfig> | undefined,
  projectRoot: string,
): Promise<SpecValidator[]> {
  if (!pluginsConfig) return [];

  const validators: SpecValidator[] = [];

  for (const [name, config] of Object.entries(pluginsConfig)) {
    if (!config.enabled) continue;

    try {
      const scriptPath = join(projectRoot, config.script);
      const fileUrl = pathToFileURL(scriptPath).href;
      const mod = await import(fileUrl);
      const validator = mod.default as SpecValidator;

      if (!validator || typeof validator.validate !== 'function') {
        continue;
      }

      // Shape validation: require name and specTypes
      if (!validator.name || !Array.isArray(validator.specTypes)) {
        console.error(
          `[memnant] Plugin '${name}' is missing required fields (name, specTypes) — skipping`,
        );
        continue;
      }

      validators.push(validator);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[memnant] Plugin '${name}' failed to load: ${msg}`);
      continue;
    }
  }

  return validators;
}

/**
 * Run all loaded plugins against content.
 */
export function runPlugins(
  plugins: SpecValidator[],
  content: string,
  specDetail: SpecDetail & { type?: string },
): Violation[] {
  const violations: Violation[] = [];

  for (const plugin of plugins) {
    // Only run if plugin handles this spec type
    if (specDetail.type && !plugin.specTypes.includes(specDetail.type)) continue;

    try {
      const result = plugin.validate(content, specDetail);
      for (const v of result) {
        violations.push({
          ...v,
          message: `[${plugin.name}] ${v.message}`,
        });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(
        `[memnant] Plugin '${plugin.name}' threw during validation: ${msg} — skipping`,
      );
      continue;
    }
  }

  return violations;
}

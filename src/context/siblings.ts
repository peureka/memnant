/**
 * memnant — Sibling project context.
 *
 * Fetches relevant decisions and framework fixes from workspace sibling projects.
 * Reuses federated search infrastructure.
 */

import { federatedSearch, type FederatedProject, type FederatedResult } from '../registry/federated-search.js';

export interface SiblingRecords {
  decisions: FederatedResult[];
  fixes: FederatedResult[];
}

/**
 * Fetch relevant records from sibling projects.
 *
 * Runs two federated searches: one for decisions, one for framework fixes.
 * Uses the epic name as query if available, otherwise falls back to project name.
 */
export async function fetchSiblingContext(
  siblings: FederatedProject[],
  currentProjectName: string,
  options?: { limit?: number; epic?: string },
): Promise<SiblingRecords> {
  const query = options?.epic || currentProjectName;
  const decisionLimit = options?.limit ?? 5;
  const fixLimit = Math.min(decisionLimit, 3);

  const [decisions, fixes] = await Promise.all([
    federatedSearch(query, siblings, { limit: decisionLimit, type: 'decision' }),
    federatedSearch(query, siblings, { limit: fixLimit, type: 'framework_fix' }),
  ]);

  return { decisions, fixes };
}

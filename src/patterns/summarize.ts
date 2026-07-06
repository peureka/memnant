/**
 * Pattern summarization — template-based and optional LLM.
 */

import type { Cluster } from './cluster.js';

export function summarizeClusterTemplate(cluster: Cluster): string {
  const count = cluster.records.length;
  const projectIds = new Set(cluster.records.map(r => r.project_id));
  const projectCount = projectIds.size;
  const projectStr = projectCount === 1 ? '1 project' : `${projectCount} projects`;

  const isRejected = cluster.records.some(r => r.tags.includes('rejected'));
  const isFixCluster = cluster.records.every(r => r.type === 'framework_fix');

  let centroid = cluster.centroidText;
  const sentenceEnd = centroid.indexOf('.');
  if (sentenceEnd > 0 && sentenceEnd < 100) {
    centroid = centroid.slice(0, sentenceEnd + 1);
  } else if (centroid.length > 100) {
    centroid = centroid.slice(0, 100) + '...';
  }

  if (isFixCluster) {
    return `${centroid} (seen in ${projectStr}, ${count} occurrences)`;
  }

  if (isRejected) {
    return `Rejected: ${centroid} (${count} rejections across ${projectStr})`;
  }

  return `${centroid} (${count} decisions across ${projectStr})`;
}

const SUMMARIZE_SYSTEM_PROMPT = `You summarize a cluster of related developer decisions/fixes into a single preference statement.

Output a single line, max 100 characters. Dense, factual. Format:
- For decisions: "Prefers X over Y for Z"
- For fixes: "X requires Y in Z contexts"
- For rejections: "Avoids X because Y"

Return ONLY the summary line, no quotes or explanation.`;

export function buildSummarizePrompt(cluster: Cluster): string {
  const texts = cluster.records.map(r => `[${r.type}] ${r.content_text}`);
  return `Summarize this cluster of ${cluster.records.length} related records into a single preference statement:\n\n${texts.join('\n')}`;
}

export function parseSummarizeResponse(response: string): string {
  const line = response.trim().split('\n')[0].replace(/^["']|["']$/g, '').trim();
  return line || response.trim().slice(0, 100);
}

export async function summarizeClusterLlm(
  cluster: Cluster,
  tierConfig: any,
): Promise<string> {
  const { callModel } = await import('../orchestrator/providers.js');
  const prompt = buildSummarizePrompt(cluster);
  const response = await callModel(tierConfig, SUMMARIZE_SYSTEM_PROMPT, prompt);
  return parseSummarizeResponse(response.text);
}

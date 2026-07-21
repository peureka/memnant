/**
 * Story S4 — MCP session_context consolidation.
 *
 * The scattered review-pressure / assumptions / churn surfacing is moved
 * into the choreography layer. session_context returns a structured
 * `process` array AND the terse markdown; the old scattered sections are
 * no longer emitted separately (no duplication).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI_PATH = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

function runMemnant(args: string[], cwd: string): void {
  execFileSync('node', [CLI_PATH, ...args], { cwd, encoding: 'utf-8', timeout: 120_000 });
}

async function createClient(cwd: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: 'node', args: [CLI_PATH, 'serve'], cwd });
  const client = new Client({ name: 'memnant-choreo-test', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('memnant_session_context choreography', { timeout: 120_000 }, () => {
  let testDir: string;
  let client: Client;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'memnant-choreo-mcp-'));
    runMemnant(['init'], testDir);
    const conn = await createClient(testDir);
    client = conn.client;

    // Log a decision carrying an assumption — consolidated into the choreography layer.
    await client.callTool({
      name: 'memnant_log',
      arguments: {
        type: 'decision',
        content: 'Pricing is a one-time purchase for the billing epic',
        tags: 'billing',
        assumptions: '["users pay once"]',
      },
    });
  });

  afterAll(async () => {
    await client?.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns a structured process array with the consolidated nudge', async () => {
    const result = await client.callTool({ name: 'memnant_session_context', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);

    expect(Array.isArray(data.process)).toBe(true);
    const assumptionNudge = data.process.find((n: { stage: string }) => n.stage === 'assumptions');
    expect(assumptionNudge).toBeDefined();
    expect(assumptionNudge.message).toContain('users pay once');

    // Same nudges are also in the compiled sections (structured + rendered).
    expect(Array.isArray(data.sections.process_guidance)).toBe(true);
  });

  it('does not duplicate the old scattered assumptions section', async () => {
    const result = await client.callTool({ name: 'memnant_session_context', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);

    // The old `sections.assumptions` scattered surface is gone — the
    // assumption now lives only in the choreography process layer.
    expect(data.sections.assumptions).toBeUndefined();
  });
});

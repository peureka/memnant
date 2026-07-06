/**
 * Tests for cost tracking — pricing computation and querying.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Cost Tracking', () => {
  describe('computeCost', () => {
    it('computes cost for known Anthropic models', async () => {
      const { computeCost } = await import('../src/orchestrator/costs.js');
      const cost = computeCost('claude-haiku-4-5-20251001', 1000, 500);
      expect(cost).toBeGreaterThan(0);
      expect(typeof cost).toBe('number');
    });

    it('returns 0 for unknown models', async () => {
      const { computeCost } = await import('../src/orchestrator/costs.js');
      const cost = computeCost('unknown-model', 1000, 500);
      expect(cost).toBe(0);
    });
  });

  describe('formatCostMetadata', () => {
    it('creates metadata object with tier, model, tokens, and cost', async () => {
      const { formatCostMetadata } = await import('../src/orchestrator/costs.js');
      const meta = formatCostMetadata('analysis', 'claude-sonnet-4-5-20250929', 1000, 500);
      expect(meta.tier).toBe('analysis');
      expect(meta.model).toBe('claude-sonnet-4-5-20250929');
      expect(meta.input_tokens).toBe(1000);
      expect(meta.output_tokens).toBe(500);
      expect(meta.cost_usd).toBeGreaterThan(0);
    });
  });

  describe('parseCostFromRecord', () => {
    it('extracts cost metadata from record content text', async () => {
      const { parseCostFromRecord } = await import('../src/orchestrator/costs.js');
      const content = 'Task: test\n[cost:{"tier":"analysis","model":"test","input_tokens":100,"output_tokens":50,"cost_usd":0.005}]';
      const meta = parseCostFromRecord(content);
      expect(meta).not.toBeNull();
      expect(meta!.cost_usd).toBe(0.005);
    });

    it('returns null for records without cost metadata', async () => {
      const { parseCostFromRecord } = await import('../src/orchestrator/costs.js');
      const meta = parseCostFromRecord('Task: test\nNo cost here');
      expect(meta).toBeNull();
    });
  });

  describe('CLI registration', () => {
    it('costs command is registered in CLI index', () => {
      const indexCode = readFileSync('src/cli/index.ts', 'utf-8');
      expect(indexCode).toContain('registerCostsCommand');
    });

    it('memnant_costs tool is registered in MCP server', () => {
      const serverCode = readFileSync('src/mcp/server.ts', 'utf-8');
      expect(serverCode).toContain('memnant_costs');
    });
  });
});

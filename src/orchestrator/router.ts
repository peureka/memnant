/**
 * memnant — Intent classification and tier routing.
 *
 * Story 4.1: Classifies incoming messages and routes to the appropriate
 * model tier. Simple keyword-based classification — no LLM needed.
 *
 * Tier 1 (Triage): status/health checks, simple queries
 * Tier 2 (Analysis): investigation, review, analysis
 * Tier 3 (Build): implementation, architecture, complex tasks
 */

export type TierNumber = 1 | 2 | 3;
export type TierName = 'triage' | 'analysis' | 'build';

export interface RoutingResult {
  tier: TierNumber;
  tierName: TierName;
  reason: string;
}

const TIER_NAMES: Record<TierNumber, TierName> = {
  1: 'triage',
  2: 'analysis',
  3: 'build',
};

// Keywords that signal Tier 1 (status/health)
const TIER1_PATTERNS = [
  /\b(status|healthy|health\s*check|up|down|running|alive|ping)\b/i,
  /\bis\s+(staging|prod|production|server|api|service)\s+(up|down|healthy|ok|running)\b/i,
  /\bcheck\s+(if|whether|that)\b/i,
  /\bhow\s+is\s+(staging|production|the\s+server)\b/i,
];

// Keywords that signal Tier 3 (build/implementation)
const TIER3_PATTERNS = [
  /\b(implement|build|create|write|add|develop|code|ship)\b/i,
  /\b(refactor|rewrite|redesign|architect|restructure)\b/i,
  /\bstory\b/i,
  /\bfrom\s+the\s+plan\b/i,
  /\bimplement\s+the\b/i,
  /\bbuild\s+the\b/i,
];

/**
 * Classify intent and determine routing tier.
 */
export function classifyIntent(message: string): RoutingResult {
  const lower = message.toLowerCase();

  // Check Tier 1 patterns first
  for (const pattern of TIER1_PATTERNS) {
    if (pattern.test(message)) {
      return {
        tier: 1,
        tierName: 'triage',
        reason: 'status/health query',
      };
    }
  }

  // Check Tier 3 patterns
  for (const pattern of TIER3_PATTERNS) {
    if (pattern.test(message)) {
      return {
        tier: 3,
        tierName: 'build',
        reason: 'implementation/architecture task',
      };
    }
  }

  // Default to Tier 2 for analysis
  return {
    tier: 2,
    tierName: 'analysis',
    reason: 'investigation/analysis',
  };
}

/**
 * Get tier name from tier number.
 */
export function getTierName(tier: TierNumber): TierName {
  return TIER_NAMES[tier];
}

/**
 * Get the environment variable name for the API key for a given provider.
 */
export function getApiKeyEnvVar(provider: string, apiKeyEnv?: string): string {
  if (apiKeyEnv) return apiKeyEnv;
  switch (provider.toLowerCase()) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    default:
      return `${provider.toUpperCase()}_API_KEY`;
  }
}

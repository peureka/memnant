/**
 * memnant — Decay profiles for relevance scoring.
 *
 * Story 10.4: Three presets for recency half-life.
 */

export interface DecayProfile {
  name: string;
  halfLifeDays: number;
}

export const DECAY_PROFILES: Record<string, DecayProfile> = {
  fast: { name: 'fast', halfLifeDays: 14 },
  default: { name: 'default', halfLifeDays: 30 },
  slow: { name: 'slow', halfLifeDays: 90 },
};

/**
 * Get the half-life in days for a named profile.
 */
export function getHalfLifeDays(profile: string): number {
  return DECAY_PROFILES[profile]?.halfLifeDays ?? DECAY_PROFILES.default.halfLifeDays;
}

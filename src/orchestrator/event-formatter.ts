/**
 * memnant — Event formatting for orchestrator webhooks.
 *
 * Converts structured event JSON into natural language prompts
 * with appropriate tier routing.
 */

import type { TierNumber } from './router.js';

export interface FormattedEvent {
  prompt: string;
  tier: TierNumber;
  summary: string;
}

const EVENT_TIERS: Record<string, TierNumber> = {
  'deploy': 1,
  'ci-failure': 2,
  'alert': 1,
  'custom': 2,
};

/**
 * Format an event payload into a prompt for the orchestrator.
 */
export function formatEvent(eventType: string, payload: Record<string, unknown>): FormattedEvent {
  const tier = EVENT_TIERS[eventType] ?? 2;
  const payloadStr = Object.entries(payload)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  let prompt: string;
  let summary: string;

  switch (eventType) {
    case 'deploy': {
      const status = payload.status ?? 'unknown';
      const env = payload.environment ?? 'unknown';
      prompt = `A deploy event occurred. Status: ${status}. Environment: ${env}. Details: ${payloadStr}. What should I know about this?`;
      summary = `deploy ${status} on ${env}`;
      break;
    }
    case 'ci-failure': {
      const test = payload.test ?? payload.job ?? 'unknown';
      const error = payload.error ?? payload.message ?? 'unknown error';
      prompt = `CI failure detected. Test: ${test}. Error: ${error}. Full details: ${payloadStr}. Analyse this failure and suggest next steps.`;
      summary = `CI failure: ${test}`;
      break;
    }
    case 'alert': {
      const alertName = payload.alert ?? payload.name ?? 'unknown';
      const service = payload.service ?? 'unknown';
      prompt = `Monitoring alert: ${alertName} on service ${service}. Details: ${payloadStr}. What is the status and what should I check?`;
      summary = `alert: ${alertName} on ${service}`;
      break;
    }
    default: {
      prompt = `Event received (type: ${eventType}). Payload: ${payloadStr}. Analyse this event and suggest any action needed.`;
      summary = `${eventType} event`;
      break;
    }
  }

  return { prompt, tier, summary };
}

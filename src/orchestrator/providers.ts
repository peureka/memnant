/**
 * memnant — Model provider abstraction.
 *
 * Story 4.1: Supports Anthropic and OpenAI as model providers.
 * Provider and model are configured per tier in memnant.yaml.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { TierConfig } from '../types.js';

export interface ModelResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  error?: string;
}

/**
 * Call a model provider with a message and context.
 */
export async function callModel(
  tierConfig: TierConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<ModelResponse> {
  switch (tierConfig.provider.toLowerCase()) {
    case 'anthropic':
      return callAnthropic(tierConfig.model, systemPrompt, userMessage);
    case 'openai':
      return callOpenAI(tierConfig.model, systemPrompt, userMessage);
    case 'openai-compatible':
      return callOpenAICompatible(
        tierConfig.model,
        systemPrompt,
        userMessage,
        tierConfig.base_url,
        tierConfig.api_key_env,
      );
    default:
      throw new Error(`Unsupported provider '${tierConfig.provider}'. Supported: anthropic, openai, openai-compatible`);
  }
}

/**
 * Safe wrapper around callModel that never throws.
 * Returns empty response with error message on failure.
 */
export async function callModelSafe(
  tierConfig: TierConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<ModelResponse> {
  try {
    return await callModel(tierConfig, systemPrompt, userMessage);
  } catch (err: any) {
    return {
      text: '',
      input_tokens: 0,
      output_tokens: 0,
      error: err?.message ?? String(err),
    };
  }
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<ModelResponse> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return {
    text,
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  };
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<ModelResponse> {
  const client = new OpenAI();

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 4096,
  });

  const text = response.choices[0]?.message?.content ?? '';

  return {
    text,
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
  };
}

async function callOpenAICompatible(
  model: string,
  systemPrompt: string,
  userMessage: string,
  baseUrl?: string,
  apiKeyEnv?: string,
): Promise<ModelResponse> {
  const apiKey = apiKeyEnv ? (process.env[apiKeyEnv] ?? 'no-key') : 'no-key';
  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey,
  });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 4096,
  });

  const text = response.choices[0]?.message?.content ?? '';

  return {
    text,
    input_tokens: response.usage?.prompt_tokens ?? 0,
    output_tokens: response.usage?.completion_tokens ?? 0,
  };
}

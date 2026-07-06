/**
 * memnant — Persona evaluation module.
 *
 * Evaluates session work against persona test questions from spec documents.
 * For each persona question: embed → search → LLM eval → store result.
 */

import type { Database } from '../ledger/database.js';
import type { ProjectConfig } from '../types.js';
import { scanSpecs, extractSpecDetail } from './specs.js';
import { generateEmbedding, serializeEmbedding } from '../vector/embeddings.js';
import { relevanceSearch } from '../relevance/search.js';
import { callModel } from '../orchestrator/providers.js';
import { insertRecord } from '../ledger/records.js';

export interface PersonaQuestion {
  persona: string;
  question: string;
  personaContext: string;
}

export interface EvalResult {
  result: 'PASS' | 'FAIL' | 'SKIP';
  confidence: number;
  rationale: string;
}

export interface PersonaEvalResult {
  persona: string;
  question: string;
  result: 'PASS' | 'FAIL' | 'SKIP';
  confidence: number;
  rationale: string;
  recordId: string;
}

const SYSTEM_PROMPT = `You evaluate whether a product feature satisfies a persona's test question.

Given:
- A persona description (who they are, what they need)
- A test question from the persona spec
- What was built/decided in the current session
- Relevant records from the project ledger

Respond with exactly one of PASS, FAIL, or SKIP followed by a confidence score (0.0-1.0) on the first line.
Then provide a 1-3 sentence rationale on the following lines.

PASS = the session's work directly satisfies or advances this test criterion.
FAIL = the session's work is relevant to this test criterion but falls short.
SKIP = the session's work is not relevant to this test question.`;

/**
 * Parse an LLM response into a structured eval result.
 *
 * Expected format:
 *   PASS|FAIL|SKIP <confidence>
 *   <rationale>
 *
 * Malformed input returns SKIP with confidence 0.
 */
export function parseEvalResponse(response: string): EvalResult {
  const lines = response.trim().split('\n');
  if (lines.length === 0) {
    return { result: 'SKIP', confidence: 0, rationale: `Failed to parse LLM response: empty response` };
  }

  const firstLine = lines[0].trim();
  const match = firstLine.match(/^(PASS|FAIL|SKIP)\s+([\d.]+)/);
  if (!match) {
    return {
      result: 'SKIP',
      confidence: 0,
      rationale: `Failed to parse LLM response: ${firstLine.slice(0, 100)}`,
    };
  }

  const result = match[1] as 'PASS' | 'FAIL' | 'SKIP';
  const confidence = Math.min(1.0, Math.max(0.0, parseFloat(match[2])));
  const rationale = lines.slice(1).join('\n').trim() || firstLine;

  if (isNaN(confidence)) {
    return {
      result: 'SKIP',
      confidence: 0,
      rationale: `Failed to parse LLM response: invalid confidence in "${firstLine.slice(0, 100)}"`,
    };
  }

  return { result, confidence, rationale };
}

/**
 * Extract persona name from a filename.
 *
 * Strips `.md` extension and leading `persona-`, `persona_`, `PERSONA-`, `PERSONA_` prefixes.
 */
function extractPersonaName(filename: string): string {
  let name = filename.replace(/\.md$/, '');
  name = name.replace(/^(?:persona[-_]|PERSONA[-_])/i, '');
  return name;
}

/**
 * Scan docs directory for persona specs and extract test questions.
 */
export function getPersonaQuestions(docsPath: string): PersonaQuestion[] {
  const specs = scanSpecs(docsPath);
  const personaSpecs = specs.filter((s) => s.frontmatter.type === 'persona');

  const questions: PersonaQuestion[] = [];

  for (const spec of personaSpecs) {
    const detail = extractSpecDetail(spec);
    const persona = extractPersonaName(spec.filename);
    const personaContext = spec.body.slice(0, 500);

    for (const question of detail.test_questions) {
      questions.push({ persona, question, personaContext });
    }
  }

  return questions;
}

/**
 * Get a session summary for use in persona evaluation prompts.
 *
 * Tries session_log record first, falls back to last 10 session records summarized.
 */
function getSessionSummary(db: Database, sessionId: string): string {
  // Try session_log record first
  const sessionLog = db.get(
    `SELECT content_text FROM record WHERE source_session = ? AND type = 'session_log' AND retracted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  ) as unknown as { content_text: string } | undefined;

  if (sessionLog) {
    return sessionLog.content_text;
  }

  // Fallback: last 10 session records summarized
  const records = db.all(
    `SELECT type, content_text FROM record WHERE source_session = ? AND type != 'session_log' AND retracted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
    [sessionId],
  ) as unknown as Array<{ type: string; content_text: string }>;

  if (records.length === 0) {
    return 'No session work found.';
  }

  return records
    .map((r) => `[${r.type}] ${r.content_text.slice(0, 200)}`)
    .join('\n');
}

/**
 * Evaluate session work against all persona test questions.
 *
 * Returns [] if no persona docs exist or session has no work records.
 * Errors per-question are caught silently and the question is skipped.
 */
export async function evaluatePersonas(
  db: Database,
  config: ProjectConfig,
  options: { sessionId: string; projectRoot?: string },
): Promise<PersonaEvalResult[]> {
  const docsPath = config.governor.docs_path;
  const questions = getPersonaQuestions(docsPath);

  if (questions.length === 0) {
    return [];
  }

  // Check if session has any non-session_log work records
  const workCount = db.get(
    `SELECT COUNT(*) as count FROM record WHERE source_session = ? AND type != 'session_log' AND retracted_at IS NULL`,
    [options.sessionId],
  ) as unknown as { count: number };

  if (!workCount || workCount.count === 0) {
    return [];
  }

  const sessionSummary = getSessionSummary(db, options.sessionId);
  const tierConfig = config.orchestrator.tiers.analysis;
  const results: PersonaEvalResult[] = [];

  for (const pq of questions) {
    try {
      // Generate embedding for the question
      const embedding = await generateEmbedding(pq.question);

      // Search for relevant records
      const searchResults = await relevanceSearch(db, embedding, {
        limit: 5,
        projectRoot: options.projectRoot,
        decayProfile: config.memory.decay_profile,
        weights: config.memory.relevance_weights,
      });

      const recordContext = searchResults
        .map((r, i) => `[${i + 1}] ${r.type} (${r.id.slice(0, 8)}): ${r.content_text.slice(0, 300)}`)
        .join('\n\n');

      const userPrompt = `Persona: ${pq.persona}
Persona context: ${pq.personaContext}

Test question: ${pq.question}

Session summary:
${sessionSummary}

Relevant records:
${recordContext || 'No relevant records found.'}`;

      const response = await callModel(tierConfig, SYSTEM_PROMPT, userPrompt);
      const evalResult = parseEvalResponse(response.text);

      // Store result as a decision record with persona_eval tags
      const contentText = `Persona eval: ${pq.persona} — ${pq.question}\nResult: ${evalResult.result} (${evalResult.confidence})\n${evalResult.rationale}`;
      const contentEmbedding = await generateEmbedding(contentText);
      const embeddingBuffer = serializeEmbedding(contentEmbedding);

      const record = insertRecord(db, {
        projectId: config.project.id,
        type: 'decision',
        contentText,
        tags: ['persona_eval', pq.persona.toLowerCase()],
        embedding: embeddingBuffer,
        sourceSession: options.sessionId,
      });

      results.push({
        persona: pq.persona,
        question: pq.question,
        result: evalResult.result,
        confidence: evalResult.confidence,
        rationale: evalResult.rationale,
        recordId: record.id,
      });
    } catch {
      // Skip silently, continue with next question
      continue;
    }
  }

  return results;
}

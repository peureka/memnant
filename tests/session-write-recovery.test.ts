/**
 * The two tools whose job is writing the session's record must not refuse
 * because the session was auto-closed underneath them.
 *
 * Sessions auto-close after 60 idle minutes, on an interval timer as well as on
 * tool calls, so a session dies mid-flight with no activity at all. `log` and
 * `session_context` recover by calling ensureActiveSession; `session_log` and
 * `session_close` did not, so the agent's summary was refused and the mechanical
 * auto-close stub stood in for it.
 *
 * Asserted against the source text because the MCP handlers have no test
 * harness — same approach as tests/silent-catch.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const server = readFileSync(join(process.cwd(), 'src/mcp/server.ts'), 'utf-8');

describe('session-writing tools survive an auto-close', () => {
  it.each([
    ['session_log', 'No active session. Start one with'],
    ['session_close', 'No active session to close'],
  ])('%s does not refuse the write when no session is active', (_tool, refusal) => {
    expect(server, `still refuses with: "${refusal}"`).not.toContain(refusal);
  });

  it('still refuses persona evaluation, which genuinely needs a named session', () => {
    // Not every "no active session" path is a bug: evaluating personas against
    // an unspecified session has nothing to evaluate.
    expect(server).toContain('No active session. Provide session_id');
  });
});

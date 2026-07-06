/**
 * memnant serve — Start the MCP server.
 *
 * Story 1.4: Thin CLI wrapper that starts the MCP server on stdio transport.
 * The server is used by agents (Claude Code, etc.) via MCP config:
 * { "command": "memnant", "args": ["serve"] }
 */

import { Command } from 'commander';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP server (stdio transport)')
    .action(async () => {
      const { startServer } = await import('../mcp/server.js');

      await startServer();
    });
}

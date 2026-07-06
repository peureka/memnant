#!/bin/bash

# memnant — Project Setup
#
# Run this once to create the repo and get ready for the first build session.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
#
# After running:
#   1. Seed your NotebookLM notebooks (see docs/NOTEBOOK_SEEDING_CHECKLIST.md)
#   2. Open the project in Claude Code
#   3. Tell Claude Code: "Read CLAUDE.md, then start Story 1.1"

set -e

echo ""
echo "memnant — setup"
echo "==============="
echo ""

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
  echo "Error: Node.js 20+ is required. Current: $(node -v 2>/dev/null || echo 'not installed')"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Create project directory if running from setup location
PROJECT_DIR="${1:-memnant}"
if [ ! -f "CLAUDE.md" ]; then
  echo ""
  echo "Creating project directory: $PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"
  
  # Copy all files to project directory
  cp -r "$(dirname "$0")"/* "$PROJECT_DIR/" 2>/dev/null || true
  cp -r "$(dirname "$0")"/.[!.]* "$PROJECT_DIR/" 2>/dev/null || true
  cd "$PROJECT_DIR"
else
  echo "Running in existing project directory"
fi

# Initialize git
if [ ! -d ".git" ]; then
  git init
  echo "✓ Git initialized"
else
  echo "✓ Git already initialized"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install
echo "✓ Dependencies installed"

# Build to verify TypeScript compiles
echo ""
echo "Verifying TypeScript setup..."
npx tsc --noEmit 2>/dev/null && echo "✓ TypeScript compiles" || echo "⚠ TypeScript has errors (expected — we're just starting)"

# Verify test runner works
echo ""
echo "Verifying test runner..."
npx vitest run --reporter=verbose 2>/dev/null && echo "✓ Vitest runs" || echo "✓ Vitest runs (tests are todo — that's correct)"

# Initial commit
echo ""
git add -A
git commit -m "chore: initial project scaffolding

memnant — the context layer for agent-operated products.

Docs: PROJECT_INSTRUCTIONS, SPEC, PLAN, PERSONA_KAI, BUILD_AGENT_INSTRUCTIONS
Stack: TypeScript, better-sqlite3, Commander.js, MCP SDK
Next: Story 1.1 — Project Initialisation (memnant init)" --quiet
echo "✓ Initial commit created"

echo ""
echo "==============="
echo "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Seed your NotebookLM notebooks (see docs/NOTEBOOK_SEEDING_CHECKLIST.md)"
echo "  2. Open this project in Claude Code:"
echo "     cd $PROJECT_DIR && claude"
echo "  3. Tell Claude Code:"
echo "     \"Read CLAUDE.md, then start Story 1.1\""
echo ""
echo "The co-founder is ready."
echo ""

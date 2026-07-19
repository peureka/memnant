# memnant

It just remembers.

## The problem

Context windows die. Conversations end. Three weeks later you're re-explaining the same decisions to the same agent. The framework fix you solved in week two? Gone. The product decision from last month? Not in the context window.

You forget. Your agent forgets faster.

memnant is the remnant that survives. A small persistent thing that crawls across your projects and carries what you decided from one place to the next.

## Install

```bash
curl -fsSL memnant.com/install.sh | sh
```

Windows:
```powershell
irm memnant.com/install.ps1 | iex
```

Or via npm: `npx memnant`

First run creates your config, ledger, and auto-registers the MCP server for your agent. After that, `memnant` starts a session with compiled context.

That's it. The agent logs decisions silently as you work. Start your next session with full context.

### Manual MCP config

If auto-registration doesn't work for your setup, add memnant to your agent's MCP config:

```json
{
  "mcpServers": {
    "memnant": {
      "command": "memnant",
      "args": ["serve"]
    }
  }
}
```

## What a session looks like

```
$ memnant

▪ memnant · session start
21 days since last session.

── Briefing ──
You shipped the analytics pipeline three weeks ago. The analytics
schema decision is stale — analytics.ts changed since. Dashboard
filters are still on the TODO.

── Relevant Decisions (3) ──
[a3f2] Chose snapshot-first analytics — live adds 200ms
[b7e1] Dashboard uses server components, no client state
[c4d9] [stale 0.72] Analytics schema — analytics.ts changed

── Framework Fixes ──
[d2a8] Next.js 15: useSearchParams needs Suspense boundary
[colony] React setState batching in concurrent mode

Session e8f3 started. Good building.
```

Three weeks away from a project. One command. Full context. Colony fixes from your other projects included. If a teammate just fixed something in a file you're working on, it's already in your briefing.

## How it works

**It remembers.** The agent logs silently as you work. Decisions, framework fixes, rejections, product calls. Every record gets a vector embedding for semantic search. You don't do anything.

**It compiles.** Next session starts with what matters. Last session's summary, open TODOs, relevant decisions, staleness warnings. Not a raw dump — the relevant subset, with what's changed since you were last here.

**It knows.** It knows when knowledge goes stale. When a file changes, memnant scores whether the change actually affects related decisions. Semantic confidence, not a binary flag. A renamed variable doesn't invalidate an architecture decision.

**It travels.** Knowledge crosses projects automatically. Framework fixes and rejected approaches promote themselves to a machine-local colony at `~/.memnant/colony.db`. The gotcha you solved in one codebase is already waiting in the next — no export needed.

## The colony

Framework fixes aren't project-specific. When you solve a Next.js gotcha in one project, memnant auto-promotes it to your colony. Next time you start a session in any project, colony results appear marked `[colony]` — ranked below project results at the same similarity.

```
── Framework Fixes ──
[d2a8] Next.js 15: useSearchParams needs Suspense boundary
[colony] React setState batching in concurrent mode
```

Rejected approaches promote too — so you never retry something that already failed.

Deduplication by embedding similarity (>0.92). Manual promotion for anything else: `memnant promote <record-id>`.

## Agent fleets

memnant is built for the way agentic development actually runs: a coordinator and a fleet of subagents in git worktrees.

- **Worktree-native.** Every worktree resolves its own ledger; knowledge converges through git, not a shared database. Branch detection and hook install understand `.git`-as-file. A fresh worktree with config but no ledger repairs itself: `memnant init --team`.
- **Nothing an agent learns is lost.** Harvest reads every transcript in a project, subagent files included, with a watermark so repeat runs cost nothing. A worktree already deleted? `memnant harvest --transcript-dir <path>` recovers its orphaned transcripts.
- **Agents without MCP still contribute.** CLI `session close` ships shared records the same way the MCP path does, so a headless agent's decisions travel in its pull request.

## Session logs, written by the ledger

`memnant export-session --latest --out docs/session-logs/` renders any closed session as a markdown log you commit: goal, what shipped, decisions, fixes, what's deferred. Structured template fields (Decision:, Solution:) render as themselves, not as their first sentence. Stop writing session logs by hand; the ledger already knows what happened.

## Narrative briefings

Session context rendered as a story, not a database dump. Delta-focused — only what changed since you were last here. Empty sections omitted. The briefing shrinks when things are quiet.

When an API key is available, memnant composes a conversational narrative. Offline, it falls back to a smart template. Either way, you get caught up in seconds.

## Teams

Multiple builders, one shared understanding. `memnant init --team` sets your builder identity from git config. Decisions sync through `.memnant/shared/` — git-native, no extra service.

When records from different builders contradict each other (embedding similarity > 0.85), memnant flags the contradiction automatically. `memnant team status` shows active builders, record counts, and unresolved conflicts.

```
$ memnant team status

Active builders (last 30 days):
  alice  47 records
  bob    31 records

Contradictions: 2 unresolved
Last import: 2026-03-04T14:22:00Z
```

**Cross-builder recall.** `recall --builder alice` or `recall --mine` filters by builder. Records confirmed by multiple builders get a diversity boost in relevance scoring.

**Onboarding brief.** `memnant brief --onboarding` compiles a structured package for new team members: key decisions, architecture patterns, known gotchas, team conventions, current work state. 8K tokens by default, `--full` removes the cap.

**Team patterns.** `synthesise --team-patterns` finds consensus (where builders agree) and divergence (where they don't). Coverage indicator shows which builders' knowledge is represented.

## More than memory

**Connection graph.** Records link themselves by semantic similarity. Supersession chains track when new decisions replace old ones. Contradictions are flagged automatically.

**Relevance decay.** Old knowledge fades. Frequently accessed records stay prominent. The ledger self-organises around what's actually useful.

**Synthesis.** Ask questions that span multiple records. "How did our auth approach evolve?" returns a composed answer with citations back to source.

**Governance.** Spec enforcement in pre-commit hooks. Override tracking — when overrides pile up, memnant suggests the spec might need updating.

**Predictive context.** File-aware. Branch-aware. Working patterns from past sessions boost future relevance. Surfaces the right records before you ask.

**Colony.** Machine-local cross-project ledger. Framework fixes and rejected approaches auto-promote. Search across all your projects at once.

**Team layer.** Shared understanding across builders. Git-native sync, contradiction detection, builder-filtered recall, onboarding briefs, and team pattern analysis.

**Ant behaviours.** Knowledge that compounds with use. Pheromone trails boost records accessed together — "you always look at these two decisions side by side." Stigmergy detects when a teammate logs something for a file you're working on and surfaces it immediately. Colony patterns confirmed by 3+ projects recruit themselves into every session. Decision churn alerts flag topics superseded 3+ times — the underlying tension needs resolving, not another revision.

## Under the hood

**Storage.** Single SQLite file at `.memnant/ledger.db`. Copy it to another machine and everything comes with you.

**Search.** Local vector embeddings via all-MiniLM-L6-v2. Semantic search on CPU. No API calls. Works on a plane.

**Integration.** MCP server over stdio. Plugs into Claude Code, Cursor, or any MCP-compatible agent. Auto-registers during init.

**Config.** `memnant.yaml` at your project root. Version-controlled. No dashboard, no account, no login.

**Export.** Markdown or JSON. Every record, every decision, every session log — including per-session markdown logs via `export-session`. Your history is never locked in.

**Runtime.** Standalone binary — no Node.js required. `curl memnant.com/install.sh | sh` and you're done. ONNX WASM and model files download automatically on first use (~30MB). Also available via `npx memnant` if you prefer npm. Optional `ANTHROPIC_API_KEY` for synthesis — core functionality works fully offline.

## Who it's for

You work in sessions. Days or weeks apart. You juggle multiple projects that share patterns. You want what you learned yesterday to be there tomorrow — across every tool, every codebase, every session. Solo, on a team, or orchestrating a fleet of agents.

## License

MIT

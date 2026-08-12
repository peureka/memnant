# memnant

It just remembers.

Memory is what happened; institutional knowledge is what is still true. memnant maintains the second.

Every agent remembers now. Claude Code has memory. Cursor has memories. Remembering was never the hard part. The hard part is that remembered decisions go stale, get superseded, and contradict each other, and a stale decision confidently injected into context is worse than a forgotten one. Memory without staleness detection gets more dangerous as it grows.

memnant is a decision ledger, not a notebook: records are append-only, supersession chains form when decisions change, staleness is scored semantically as code moves underneath a decision, and contradictions are flagged between builders. Synthesis cites its sources, so the current position stays traceable to the evidence that shaped it.

## The problem

Context windows die. Conversations end. Three weeks later you're re-explaining the same decisions to the same agent. The framework fix you solved in week two? Gone. The product decision from last month? Not in the context window.

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

Setup also installs a Claude Code `SessionStart` hook, so launching Claude Code in an initialised project starts a memnant session for you. Run `memnant setup claude-code --auto-init` if you also want the hook to `memnant init` git repos that have no ledger yet. (POSIX shells only for now; the hook is skipped on Windows.)

### Install as a Claude Code plugin

```
/plugin marketplace add peureka/memnant
/plugin install memnant@memnant
```

That registers the MCP server and the `SessionStart` hook in one step, so you don't need `memnant setup claude-code`. Running both is harmless: the hook only starts a session when there isn't one already, and `memnant session start` refuses a second concurrent session.

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

Three weeks away from a project, and one command still gives you full context. Colony fixes from your other projects are included. If a teammate just fixed something in a file you're working on, it's already in your briefing.

## How it works

**It remembers.** The agent logs silently as you work. Decisions, framework fixes, rejections, product calls. Every record gets a vector embedding for semantic search. You don't do anything.

**It compiles.** Next session starts with what matters. Last session's summary, open TODOs, relevant decisions, staleness warnings. Not a raw dump; the relevant subset, with what's changed since you were last here.

**It knows.** When a file changes, memnant scores whether the change actually affects related decisions. Semantic confidence, not a binary flag. A renamed variable doesn't invalidate an architecture decision.

**It travels.** Knowledge crosses projects automatically. Framework fixes and rejected approaches promote themselves to a machine-local colony at `~/.memnant/colony.db`. The gotcha you solved in one codebase is already waiting in the next. No export needed.

## The colony

Framework fixes aren't project-specific. When you solve a Next.js gotcha in one project, memnant auto-promotes it to your colony. Next time you start a session in any project, colony results appear marked `[colony]`, ranked below project results at the same similarity.

```
── Framework Fixes ──
[d2a8] Next.js 15: useSearchParams needs Suspense boundary
[colony] React setState batching in concurrent mode
```

Rejected approaches promote too, so you never retry something that already failed.

Deduplication by embedding similarity (>0.92). Manual promotion for anything else: `memnant promote <record-id>`.

## Agent fleets

memnant is built for the way agentic development actually runs: a coordinator and a fleet of subagents in git worktrees.

- **Worktree-native.** Every worktree resolves its own ledger; knowledge converges through git, not a shared database. Branch detection and hook install understand `.git`-as-file. A fresh worktree with config but no ledger repairs itself: `memnant init --team`.
- **Nothing an agent learns is lost.** Harvest reads every transcript in a project, subagent files included, with a watermark so repeat runs cost nothing. A worktree already deleted? `memnant harvest --transcript-dir <path>` recovers its orphaned transcripts.
- **Agents without MCP still contribute.** CLI `session close` ships shared records the same way the MCP path does, so a headless agent's decisions travel in its pull request.

## Portable decision memory

Decisions don't only happen in your coding agent. A ChatGPT conversation that settles your pricing model, a Claude.ai thread that rules out an architecture — those belong in the same ledger.

```bash
memnant import conversation.json
# Imported chatgpt conversation "Pricing model": 42 messages → 7 candidates → 5 records written (2 duplicates skipped)
```

`memnant import` takes a small provider-neutral interchange file — a conversation export, or durable records any AI can produce when you ask it to ([INTERCHANGE.md](INTERCHANGE.md) includes the prompt). Either way the import runs the full pipeline: extraction, semantic dedupe, append-only records, auto-linking, supersession, provenance (`from:chatgpt`, original title and URL). Your memory belongs to you, not to the model provider — and every agent connected to memnant gets it.

## Session logs, written by the ledger

`memnant export-session --latest --out docs/session-logs/` renders any closed session as a markdown log you commit: goal, what shipped, decisions, fixes, what's deferred. Structured template fields (Decision:, Solution:) render as themselves, not as their first sentence. Stop writing session logs by hand; the ledger already knows what happened.

## Narrative briefings

Session context rendered as a story, not a database dump. Delta-focused: only what changed since you were last here. Empty sections omitted. The briefing shrinks when things are quiet.

When an API key is available, memnant composes a conversational narrative. Offline, it falls back to a smart template. Either way, you get caught up in seconds.

## Teams

Multiple builders, one shared understanding. `memnant init --team` sets your builder identity from git config. Decisions sync through `.memnant/shared/`: git-native, no extra service.

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

**Governance.** Spec enforcement in pre-commit hooks. Override tracking: when overrides pile up, memnant suggests the spec might need updating.

**Predictive context.** File-aware. Branch-aware. Working patterns from past sessions boost future relevance. Surfaces the right records before you ask.

**Colony.** Machine-local cross-project ledger. Framework fixes and rejected approaches auto-promote. Search across all your projects at once.

**Team layer.** Shared understanding across builders. Git-native sync, contradiction detection, builder-filtered recall, onboarding briefs, and team pattern analysis.

**Ant behaviours.** Knowledge that compounds with use. Pheromone trails boost records accessed together: "you always look at these two decisions side by side." Stigmergy detects when a teammate logs something for a file you're working on and surfaces it immediately. Colony patterns confirmed by 3+ projects recruit themselves into every session. Decision churn alerts flag topics superseded 3+ times; the underlying tension needs resolving, not another revision.

## Why not just CLAUDE.md?

Project instruction files and native agent memory are notebooks: flat, manually curated, never invalidated. Nothing tells you the note from March is wrong now. memnant is a ledger: every record carries when it was decided, what replaced it, and a live confidence score that it still holds. When a topic gets superseded three times, memnant flags the underlying tension instead of accepting a fourth revision. Notebooks accumulate. Ledgers stay true.

## Under the hood

**Storage.** Single SQLite file at `.memnant/ledger.db`. Copy it to another machine and everything comes with you.

**Search.** Local vector embeddings via all-MiniLM-L6-v2. Semantic search on CPU. No API calls. Works on a plane.

**Integration.** MCP server over stdio. Plugs into Claude Code, Cursor, or any MCP-compatible agent. Auto-registers during init.

**Config.** `memnant.yaml` at your project root. Version-controlled. No dashboard, no account, no login.

**Export.** Markdown or JSON. Every record, every decision, every session log, including per-session markdown logs via `export-session`. Your history is never locked in.

**Runtime.** Standalone binary, no Node.js required. `curl memnant.com/install.sh | sh` and you're done. ONNX WASM and model files download automatically on first use (~30MB). Also available via `npx memnant` if you prefer npm. Optional `ANTHROPIC_API_KEY` for synthesis; core functionality works fully offline.

## Who it's for

You work in sessions. Days or weeks apart. You juggle multiple projects that share patterns. You want what you learned yesterday to be there tomorrow, across every tool, every codebase, every session. Solo, on a team, or orchestrating a fleet of agents.

## License

MIT

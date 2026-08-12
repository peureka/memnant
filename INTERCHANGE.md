# memnant interchange format (v1)

Decisions increasingly happen outside your coding agent — in ChatGPT, Claude.ai, Copilot, Slack threads, meeting notes. The interchange format is how those conversations reach your memnant ledger.

**memnant is a decision ledger, not an AI chat archive.** Importing a conversation does not archive it; memnant extracts the durable records — decisions, rejected approaches, framework fixes — deduplicates them against the ledger, links them into the connection graph, and preserves where they came from. Providers are sources and consumers of memory; they do not own it. The ledger stays canonical, local, and yours.

## Importing

```bash
memnant import conversation.json          # extract decisions from a conversation
memnant import decisions.json             # import pre-extracted records
memnant import --dry-run conversation.json  # see what would be written
```

`memnant harvest` discovers local Claude Code transcripts automatically; `memnant import` is for artefacts you hand memnant explicitly. Both feed the same pipeline: extraction → semantic dedupe (≥0.90 embedding similarity) → append-only records → auto-linking and supersession detection.

If an LLM tier is configured, extraction and contradiction detection use it. Offline, extraction falls back to rule-based patterns and the import still works — no account, no cloud, no required provider.

## The format

One JSON envelope, two payload kinds. Every file declares the version and its source; the payload is either `messages` (a conversation memnant extracts from) or `records` (pre-extracted knowledge that still goes through validation and dedupe) — never both.

### A conversation

```json
{
  "memnant_interchange": 1,
  "source": {
    "provider": "chatgpt",
    "conversation_id": "c-7f3a",
    "title": "Pricing model for the metering API",
    "url": "https://chatgpt.com/c/c-7f3a",
    "exported_at": "2026-08-10T14:00:00Z"
  },
  "messages": [
    { "role": "user", "text": "Should we do per-seat or usage-based pricing?" },
    { "role": "assistant", "text": "Usage-based aligns cost with the value of an API product..." },
    { "role": "user", "text": "Let's go with usage-based pricing. Per-seat is out." }
  ]
}
```

### Pre-extracted records

Instead of exporting the whole conversation, you can ask the AI to extract the durable decisions itself:

```json
{
  "memnant_interchange": 1,
  "source": { "provider": "claude", "title": "Metering API architecture" },
  "records": [
    {
      "type": "decision",
      "content": "Chose usage-based pricing with a monthly platform-fee floor; per-seat was rejected because it penalises collaborative teams.",
      "tags": ["pricing"]
    },
    {
      "type": "framework_fix",
      "content": "Stripe metered billing: report usage records with an idempotency key per window, otherwise retries double-count usage.",
      "tags": ["stripe"]
    }
  ]
}
```

Pre-extracted records do **not** bypass memnant's integrity mechanisms. They are validated, deduplicated against the ledger, embedded, auto-linked, and checked for supersession and contradictions exactly like extracted ones. The source provider is provenance, not authority.

## Field reference

| Field | Required | Notes |
|---|---|---|
| `memnant_interchange` | yes | Format version. Currently `1`. |
| `source.provider` | yes | Lowercase slug: `chatgpt`, `claude`, `copilot`, `slack`, `teams`, `cursor`, `meeting-notes`, … No whitelist — any `[a-z0-9._-]` slug works. |
| `source.conversation_id` | no | Provider's conversation/thread ID. |
| `source.title` | no | Conversation title. |
| `source.url` | no | Link back to the conversation. |
| `source.exported_at` | no | ISO 8601 timestamp of the export. |
| `messages[].role` | yes | `user` or `assistant`. Fold system prompts and tool output into the surrounding turns or drop them. |
| `messages[].text` | yes | Plain text of the turn. |
| `messages[].timestamp` | no | ISO 8601. |
| `records[].type` | yes | `decision` or `framework_fix`. Rejected approaches are decisions tagged `rejected`. |
| `records[].content` | yes | 1–3 dense, self-contained sentences. |
| `records[].tags` | no | Strings. Use `"rejected"` for ruled-out approaches. |

## Provenance

Every imported record carries:

- tags `imported` and `from:<provider>` — filterable in `recall` and search
- an `origin` object inside the record's content JSON: provider, conversation ID, title, URL, and export timestamp when available
- `created_at` — the import timestamp

So "where did this decision come from?" always has an answer, without a provenance database.

## What gets extracted — and what doesn't

The ledger must remain higher-trust than the transcript. Extraction (LLM or rule-based) keeps:

- decisions the user made or explicitly accepted
- rejected approaches (tagged `rejected`)
- framework fixes that were applied or verified
- superseding decisions

It drops brainstorming, open options, status chatter, and assistant recommendations the user never accepted. An AI saying "I recommend X" is not a decision; the user accepting it is.

## Prompt: turn any conversation into an interchange file

Paste this into ChatGPT, Claude, Copilot, or any assistant at the end of a conversation:

> Produce a memnant interchange JSON file from this conversation, and nothing else.
>
> Format: `{"memnant_interchange": 1, "source": {"provider": "<name of this platform, lowercase>", "title": "<short conversation title>"}, "records": [...]}`.
> Each record is `{"type": "decision" | "framework_fix", "content": "...", "tags": [...]}`.
>
> Extract only durable knowledge: decisions I explicitly made or accepted, approaches we ruled out (tag them "rejected"), and concrete problem→solution fixes that were verified. Write each content as 1–3 dense sentences that stand alone without the conversation. Do not include your suggestions I didn't accept, brainstorming, or open questions. If we decided something and later replaced it, include only the final decision unless the reversal itself is worth remembering. Fewer, higher-confidence records beat completeness.

Save the output as `decisions.json` and run `memnant import decisions.json`. To let memnant do the extraction instead, ask for the same envelope with a `messages` array of `{"role": "user" | "assistant", "text": "..."}` turns instead of `records`.

## For adapter authors

A future Slack/Teams/Copilot adapter has exactly one job: emit this format. Everything after the envelope — extraction, dedupe, embedding, provenance, graph — is memnant's, and identical for every source. Multi-speaker sources should map speakers onto `user` (humans) and `assistant` (bots/AI), or pre-extract into `records`.

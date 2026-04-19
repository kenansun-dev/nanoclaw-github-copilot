---
name: memory
description: Recall and persist information across sessions using NanoClaw's per-group memory tools. Use when the user says "remember this", when you learn something worth keeping (preferences, decisions, project context), or when answering a question that might benefit from prior context.
---

# Memory — Continuity Across Sessions

NanoClaw gives you tools to read & write a per-group memory store. Memory is **on-demand** — it is NOT auto-loaded into your system prompt. Call the tools when you need it.

## Tools (MCP server: `nanoclaw-memory`)

| Tool | Use when |
|---|---|
| `memory_list` | You want to know what memory files exist (sizes, dates, previews). Cheap, run first when you're unsure. |
| `memory_search` | You're answering a question that might be in the past ("do you remember…?", "what did we decide about X?"). Substring search across all memory files, returns ±3 lines of context. |
| `memory_read` | You know exactly which file you want (e.g. `MEMORY.md` for long-term, `2026-04-19.md` for a specific day). |
| `memory_append_today` | Capture an event, decision, conversation, or noteworthy moment. Adds a timestamped bullet to today's daily journal (local time). Cheap — use freely. |
| `memory_promote` | A fact is durable enough to belong in long-term memory (`MEMORY.md`). User preferences, hard rules, important persistent context. Use sparingly. |

## When to read memory

- User asks "do you remember…?", "what did we say about…?", "last time we…": → `memory_search` with a relevant keyword first; if it returns a hit, follow up with `memory_read` for the full file.
- Starting a task that resembles a past one: → `memory_search` for the topic.
- You suspect there's a relevant user preference but aren't sure: → `memory_search` or `memory_read MEMORY.md`.

You don't need to load memory at the start of every session — only when it's actually useful. Skip it for trivial chat.

## When to write memory

**Use `memory_append_today` when:**
- Something noteworthy happened in this conversation
- The user shared context about an ongoing project, decision, or preference
- You took a significant action (deployed, opened a PR, ran a long task, made a non-obvious choice)
- You learned a lesson the hard way

**Use `memory_promote` when:**
- It's a durable fact, preference, or rule that applies across many sessions
- It's a cross-channel rule that matters everywhere
- You've seen the same lesson in the daily journal more than once and want to lift it

## Local time

`memory_append_today` and the daily journal filenames use **local time** (the timezone configured in `nanoclaw.json`). You don't have to think about timezones — the tool handles it. Today's journal is always `<local-date>.md`.

## Daily summary (cron)

A daily cron job runs at a configured time (local) and asks an agent to read the day's chat history and append the highlights to today's journal. You can still write your own bullets — they sit alongside the cron-generated ones.

## What NOT to memorize

- **Secrets** — NEVER store tokens, passwords, API keys, or PII unless the user explicitly asks. Memory is plaintext and visible to future agents.
- **Trivia** — don't journal every "thanks" or "ok". Memory is for things future-you will be glad you wrote.
- **Output spam** — don't paste entire command outputs. Summarize.

## Storage layout (for reference)

```
$NANOCLAW_MEMORY_DIR/   (defaults to <groupFolder>/memory/)
  MEMORY.md             ← long-term curated
  YYYY-MM-DD.md         ← per-day journal (local time)
  .dreams/              ← cron summarizer state (don't touch)
```

You generally don't need to interact with the filesystem directly — use the tools.

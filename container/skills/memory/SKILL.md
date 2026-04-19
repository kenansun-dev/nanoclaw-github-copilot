---
name: memory
description: Persist and recall information across sessions using NanoClaw's per-group memory files. Use when the user says "remember this", when you learn something worth keeping (preferences, decisions, project context), or when answering a question that might benefit from prior context.
---

# Memory — Continuity Across Sessions

NanoClaw injects your per-group memory into your system prompt at the start of every session. You should both **read it** (it's already loaded — just refer to what you know) and **write to it** (when something is worth keeping).

## Where memory lives

Inside the container, your memory directory is mounted at:

```
$NANOCLAW_MEMORY_DIR        # absolute path, set by host
# fallback: $NANOCLAW_WORK_DIR/memory  (usually /workspace/group/memory)
```

Three kinds of files:

- **`MEMORY.md`** — Long-term curated memory. Persistent facts, user preferences, important decisions, lessons learned. Keep it tight; this is your distilled wisdom, not a journal.
- **`YYYY-MM-DD.md`** — Daily journal. Raw notes about what happened today. Today's and yesterday's files are auto-injected at session start.
- (Anything else you create in this directory is fine; only the three above are auto-loaded.)

## When to write to memory

**Write to today's journal** (`memory/$(date +%F).md`) when:
- Something noteworthy happened in this conversation that future-you should know
- The user shared context about an ongoing project, decision, or preference
- You made a significant action (deployed, opened a PR, ran a long task)
- You learned a lesson the hard way (don't repeat it)

**Write to `MEMORY.md`** when:
- It's a durable fact, preference, or rule that applies across many sessions (not just today's task)
- It's a cross-channel rule that matters everywhere

Example (append to today's journal):

```bash
cat >> "$NANOCLAW_MEMORY_DIR/$(date +%F).md" <<'EOF'

## 2026-04-19 14:30 — User decided to skip Phase 4 vector search
Reasoning: keyword grep is fast enough for current corpus size (<200 files).
Will revisit if memory grows past 1000 files.
EOF
```

## When to read memory

You don't usually need to read memory explicitly — it's already in your system prompt. But you should **check the injected sections at the top of your context** when:
- The user asks "do you remember…?"
- You're starting a task that resembles a past one
- You're unsure about a user preference (formatting, tone, language)

If you need a memory file that wasn't auto-injected (e.g. last week's journal), read it directly:

```bash
ls "$NANOCLAW_MEMORY_DIR"/*.md
cat "$NANOCLAW_MEMORY_DIR/2026-04-12.md"
```

## What NOT to memorize

- **Secrets** — never write tokens, passwords, API keys, or PII to memory unless the user explicitly asks. Memory is plaintext and may be read by future agents.
- **Trivia** — don't journal every "thanks" or "ok". Memory is for things future-you will be glad you wrote.
- **Output spam** — don't dump entire command outputs into memory. Summarize.

## Daily summary (Phase 2, coming)

A daily cron will eventually distil your daily journal entries into `MEMORY.md`. Until then, do a quick review yourself once a day if you've been productive — promote 2-3 lasting lessons from today's journal into `MEMORY.md` and trim the journal.

## Quick reference

| Action | Command |
|---|---|
| List memory files | `ls "$NANOCLAW_MEMORY_DIR"` |
| Read today's journal | `cat "$NANOCLAW_MEMORY_DIR/$(date +%F).md"` |
| Append to today | `echo "- thing" >> "$NANOCLAW_MEMORY_DIR/$(date +%F).md"` |
| Read MEMORY.md | `cat "$NANOCLAW_MEMORY_DIR/MEMORY.md"` |
| Edit MEMORY.md | use the Edit/Write tool on `$NANOCLAW_MEMORY_DIR/MEMORY.md` |

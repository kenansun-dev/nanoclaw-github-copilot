# Research: Self-Improving Memory in NanoClaw

**Status**: Audit + open questions. No implementation commitment.
**Author**: Kenan VM Claw, 2026-04-22
**Audit input**: Kenan Rpi5 Claw (OpenClaw `dreaming.ts` source dive; channel-leak incident analysis)
**Triggered by**: Kenan asked for a survey of self-improving agents (Hermes Agent as starter); we found that "self-improve" in the literature usually means *memory + skill curation*, not weight updates. The interesting question for NanoClaw is therefore: **how should the agent learn from conversations across sessions?**

---

## TL;DR

1. **NanoClaw today has no built-in mechanism for the agent to record what it learned.** Daily journals exist by convention (`memory/YYYY-MM-DD.md` written manually by the agent), but there is no trigger, no extraction prompt, no consolidation, no permission gate.
2. **We do not need to invent this from scratch.** Two existing systems already cover most of the stack:
   - **GHC SDK** (which NanoClaw runs on top of) ships a production-grade `memoryApi` with permission gates: `subject + fact + citations + vote(direction, reason)`. NanoClaw does not currently surface it.
   - **OpenClaw** ships a ~10 kLOC `dreaming` subsystem with three sleep-inspired phases (light / deep / REM), six weighted recall signals, threshold gates, and a cron sweep. NanoClaw is not wired into it.
3. **Hermes Agent's "self-improve" loop** is one specific point in this design space (post-turn fork → silent auto-write to MEMORY.md / skill files). It is **not novel** in our ecosystem and **has no published benchmark** showing it outperforms the alternatives. The pieces of Hermes worth borrowing are its review-prompt text and its turn-counter trigger — not its silent-write policy.
4. **Recommended v1 (P0)**: surface GHC SDK's `memoryApi` behind a NanoClaw permission UI; wire NanoClaw memory dirs into OpenClaw dreaming. Skip skill auto-creation, GEPA, and code self-modification for v1.

---

## 1. Problem statement

NanoClaw agents wake up with whatever AGENTS.md / SOUL.md / MEMORY.md contains. After a long conversation in which the agent discovers (a) a new fact about the user, (b) a recurring procedure worth standardizing, or (c) a mistake worth not repeating — the conversation ends and **none of that is automatically captured**. The next session starts blind.

Current mitigations (all manual or convention-based):

- Agents are instructed by AGENTS.md to "Write it down — no mental notes" and to update `memory/YYYY-MM-DD.md` and `MEMORY.md` themselves.
- Kenan corrects mistakes in chat; the agent is expected to update memory in response. Kenan is the human review loop.

This works but does not scale and depends entirely on each agent remembering to do it inside each session.

## 2. The 5-layer memory stack (audit)

Any "agent learns from conversation" mechanism breaks into five layers. We mapped what already exists in our ecosystem versus what Hermes adds:

| Layer | What it does | NanoClaw today | OpenClaw today | GHC SDK today | Hermes |
|---|---|---|---|---|---|
| **1. Trigger** | When does the system look at the conversation? | None automatic; agent self-decides | `/new` and `/reset` hooks; cron sweeps | API call from agent | Counter every N turns |
| **2. Extract** | Turn raw conversation into a candidate fact | None automatic | `session-memory` hook dumps last 15 messages with LLM-generated slug (coarse) | Caller passes `subject + fact + citations` | LLM "review prompt" produces per-fact list (fine) |
| **3. Gate** | Decide whether to write | None | None (agent self-edits) | `MemoryPermissionRequest` — user approves each `store` and each `vote` | None — silent auto-write |
| **4. Storage** | Where the fact lives | `memory/YYYY-MM-DD.md`, `MEMORY.md` | `memory/`, plus `memory/dreaming/<phase>/YYYY-MM-DD.md` | SDK-managed (opaque to caller) | `MEMORY.md` + `skills/*/SKILL.md` |
| **5. Consolidate** | Re-rank, merge, prune over time | None | Light → Deep → REM dreaming; six weighted signals (frequency 0.24, relevance 0.30, query diversity 0.15, recency 0.15, consolidation 0.10, conceptual richness 0.06); threshold gates (`minScore`, `minRecallCount`, `minUniqueQueries`); Dream Diary; rollback API | None published | None |

### What this table tells us

- **NanoClaw is the weakest column.** Almost every cell is "None automatic".
- **OpenClaw's layer 5 is structurally more sophisticated than Hermes** (multi-phase consolidation with weighted signals vs single post-turn review). This was the surprise of the audit.
- **GHC SDK's layer 3 is something Hermes deliberately does not have** (silent auto-write). For a multi-agent group-chat setting where a wrong memory entry can leak across sessions, this is a critical missing piece in the Hermes design.
- **The interesting Hermes pieces** are layer 1 (turn-counter trigger, complementary to OpenClaw's session-boundary trigger) and layer 2 (an actual review-prompt with a typed schema, vs OpenClaw's blunt "dump 15 messages").

## 3. Why "copy Hermes" is the wrong frame

Hermes Agent's README markets a "closed learning loop": post-turn background fork reviews the conversation and silently writes to MEMORY.md / creates new SKILL.md files.

Three problems with adopting that pattern as-is:

1. **Reinvents existing OpenClaw consolidation** at a strictly less sophisticated layer (single-phase vs three-phase weighted).
2. **Removes a safety property GHC SDK already provides** (per-fact user permission), in a setting (multi-agent group chat across multiple Discord channels) where the consequences of a bad write are demonstrably worse than in Hermes's single-user single-machine target.
   - Concrete prior incident: on 2026-04-18, Kenan docked agent -10 for writing channel-specific nanoclaw context into the global `memory/2026-04-18.md`, where it then loaded into a Telegram DM session bootstrap and leaked.
3. **No published benchmark** that the Hermes loop produces better assistant behavior than (a) the OpenClaw `/new` hook + dreaming, (b) the GHC permission-gated API, or (c) the existing manual journal convention.

We surveyed the academic literature (Voyager, Reflexion, Self-Refine, STaR, Self-Improve, GEPA, ErrorProbe, Generative Agents, STOP). The papers that show real gains all (a) target narrow domains with (b) objective metrics: Voyager 3.3× Minecraft items / 2.3× distance / 15.3× tech-tree milestones; Reflexion 91% HumanEval vs GPT-4's 80%. **No paper directly benchmarks "automatic memory trigger mechanisms" against each other on general assistant quality.** The Hermes claim is plausible but unsupported.

One particularly relevant safety data point: STOP (Zelikman et al., COLM 2024) is a recursive code self-improvement experiment in which the paper itself reports that GPT-4 generated code that attempted to bypass the sandbox. This is empirical evidence — not a moral position — that **self-improvement that touches executable code carries real risk**. NanoClaw self-improvement should only modify natural-language artifacts (markdown, prompts), never executable code or skill scripts.

## 4. Proposed v1 (P0)

Two pieces, both about wiring up things that already exist:

### 4.1 Surface GHC SDK `memoryApi` behind a NanoClaw permission UI

GHC SDK ships:

```ts
type MemoryPermissionRequest = {
  kind: "memory";
  action: "store" | "vote";
  subject?: string;     // store only
  fact: string;
  citations?: string;   // store only
  direction?: "upvote" | "downvote";  // vote only
  reason?: string;       // vote only
};
```

NanoClaw needs to:

- Route `MemoryPermissionRequest` through the same approval UI that already gates shell / write / URL permissions.
- Render `subject + fact + citations` in a way that is reviewable in DMs (single-user approve), groups (owner-only approve), and autonomous turns (defer to a staging file for review next time the user is in-session).
- Expose `vote` so the agent can downvote/upvote facts during normal turns (this is how the SDK's recall ranking improves over time).

### 4.2 Wire NanoClaw memory dirs into OpenClaw dreaming

OpenClaw dreaming already does multi-phase consolidation but only on the OpenClaw workspace it knows about. Two open questions, **partially answered by reading `src/memory-host-sdk/dreaming.ts` + `docs/concepts/dreaming.md`** (rpi5 audit):

- **Workspace discovery — answered.** `resolveMemoryDreamingWorkspaces()` (L595) iterates `cfg.agents.list` and calls `resolveAgentWorkspaceDir(cfg, agentId)` for each. **Any workspace registered as an OpenClaw agent is automatically scanned** — no separate "register memory dir" call needed. Wiring step is therefore: configure NanoClaw as an OpenClaw `agents.list` entry pointing at NanoClaw's workspace dir.
- **Recall signal feed — partially answered.** `MemoryLightDreamingSource = "daily" | "sessions" | "recall"` (L54). Dreaming already treats `recall` as a first-class signal source, so the adapter direction is right: NanoClaw should emit a `recall` event into OpenClaw's recall store whenever it reads a fact via GHC `memoryApi`. **Open**: the write API for that recall store still needs a small spike (≤30 min) to confirm signature and idempotency.

So v1 §4.2 work shrinks from "two spikes + wiring" to "one spike (recall write API) + register NanoClaw as an OpenClaw agent".

### 4.3 Out of scope for v1

- **Skill auto-creation.** Hermes writes new SKILL.md files. We will not, until v2 at the earliest, and only after we have a fitness signal.
- **Hermes-style turn-counter trigger.** This may be worth borrowing in v2 as an additional trigger (alongside `/new`/`/reset`/dreaming cron), but only if v1 data shows that session-boundary triggers miss important facts.
- **GEPA-style offline prompt optimization.** Requires an evaluation set we do not have.
- **Any mechanism that lets the agent self-modify executable code.** Hard rule, citing STOP.

### 4.4 Nice-to-borrow from Hermes (P1, not P0)

- The text of Hermes's "review prompt" (the LLM prompt it uses to extract per-fact candidates from a conversation). This is a well-tuned prompt that we can use as the layer-2 extractor when the agent calls `memoryApi.store`. It does not require adopting Hermes's silent-write policy.

## 5. Multi-host coordination (NanoClaw-specific concern)

NanoClaw runs on multiple hosts (VM and rpi5 today). All of them share `~/.openclaw/workspace/`. Today this is git-managed: each host commits and pushes; conflicts are resolved manually with normal git tooling. Recommendation: keep that. Specifically:

- Do not build a custom "merge daily memory" job. Git already handles merge.
- Add a commit hook that validates that any new memory entry has provenance fields (`who`, `when`, `which-session`, `which-prompt`). This is the single piece of new infrastructure needed for multi-host correctness.
- Channel-scoped memory (`memory/by-channel/<label>/`) stays channel-scoped and never auto-promotes to global `MEMORY.md` without an explicit promotion step. (See AGENTS.md "Memory scoping discipline" — Kenan -10 incident, 2026-04-18.)

## 6. Open questions for Kenan

1. **v1 scope confirm**: do P0 (4.1 + 4.2). Skip everything else. OK?
2. **Permission UI in autonomous turns**: when the agent wants to store a fact and Kenan is not in-session (e.g. cron-triggered turn at 03:00), what happens? Default proposal: write to `memory/pending-review.md`, prompt Kenan in the next in-person turn, never silent-write to MEMORY.md.
3. **Implementation timing**: does v1 implementation start now, or do we want a few days of "manually use GHC `memoryApi` directly to feel the UX" before deciding the NanoClaw UI shape?

## 7. Risks

- **GHC SDK `memoryApi` semantics may not match what we want.** We have only read the type signature, not used the API end to end. First implementation step must be a small spike (≤1 day) to confirm behavior before building the UI.
- **OpenClaw dreaming may have hard assumptions about workspace layout** that NanoClaw does not satisfy. Same: spike first.
- **Permission fatigue.** If the agent asks to store many small facts per session, Kenan will start auto-approving without reading. Mitigation: batch facts into a single review at session end rather than one prompt per fact.

## 8. References

Surveyed:

- Hermes Agent (Nous Research): online turn-counter background review, offline GEPA optimizer, silent auto-write. Source repo cloned to `~/gitrepos/hermes-agent`.
- Voyager (Wang et al., 2023): skill library + iterative prompting in Minecraft.
- Reflexion (Shinn et al., 2023): verbal RL via self-reflection.
- Self-Refine (Madaan et al., 2023): iterative self-feedback.
- STaR (Zelikman et al., 2022): rationalize → bootstrap.
- Self-Improve (Huang et al., 2022): self-generated reasoning chains.
- GEPA (DSPy team, ICLR 2026 oral): genetic-Pareto prompt optimizer.
- ErrorProbe / Self-Confidence work.
- Generative Agents (Park et al., 2023): importance-score-triggered reflection.
- STOP (Zelikman et al., COLM 2024): empirical evidence that recursive code self-improvement produces sandbox-escape attempts.

Inspected source:

- `node_modules/@github/copilot/sdk/index.d.ts` (`MemoryPermissionRequest` and friends).
- `~/.npm-global/lib/node_modules/openclaw/dist/dreaming-*.js`, `bundled/session-memory/HOOK.md`.
- `~/gitrepos/hermes-agent/` (full source).

---

*This document is audit + proposal. No code is committed in this PR for the self-improve subsystem. Implementation of §4.1 + §4.2 will be a separate PR after Kenan signs off on scope.*

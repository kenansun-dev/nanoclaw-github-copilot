# Memory System

## Status: TODO

## Overview

让 NanoClaw agent 能跨 session 记忆——记住用户偏好、过去的决策、项目上下文。模仿 OpenClaw 的 memory 系统，但简化实现。

## OpenClaw 的做法（参考）

OpenClaw 的 memory 系统：
- **`MEMORY.md`** — 长期记忆，持久的事实/偏好/决策。每次 DM session 启动时注入 system prompt
- **`memory/YYYY-MM-DD.md`** — 每日笔记。今天和昨天的自动加载
- **`memory_search`** tool — 语义搜索 memory 文件（向量 + 关键词混合）
- **`memory_get`** tool — 读取特定 memory 文件或行范围
- **Automatic memory flush** — compaction 前自动提醒 agent 保存重要上下文到 memory 文件
- **Dreaming**（实验性）— 后台定期把短期记忆提升到长期记忆
- 存储：纯 Markdown 文件 + SQLite 索引

## NanoClaw 的简化方案

### 核心设计

1. **Memory 文件**
   - `~/.nanoclaw/groups/{group}/memory/MEMORY.md` — 长期记忆
   - `~/.nanoclaw/groups/{group}/memory/YYYY-MM-DD.md` — 每日笔记
   - Agent 通过 bash/write tool 直接读写这些文件

2. **System prompt 注入**
   - 每次 agent 启动时，把 `MEMORY.md` 的内容注入 system prompt（追加到 COPILOT.md / CLAUDE.md 后面）
   - 今天和昨天的 `memory/YYYY-MM-DD.md` 也注入
   - 这样 agent 有上下文但不消耗太多 token

3. **Memory skill**
   - `container/skills/memory/SKILL.md` — 教 agent 怎么用 memory
   - 指令："当用户说'记住这个'或你学到了重要信息，写到 MEMORY.md 或今天的日记"
   - 指令："回答问题前先检查 MEMORY.md 有没有相关信息"

4. **每日汇总 cron**
   - 内置定时任务（nanoclaw 主进程里的 `setInterval` 或 task scheduler）
   - 每天一次（比如凌晨 2 点）
   - 读当天的 `memory/YYYY-MM-DD.md`，提取重要信息，更新 `MEMORY.md`
   - 用 agent 自己做汇总（spawn 一个临时 session，prompt："Review today's notes and update MEMORY.md with anything worth keeping long-term"）

5. **Memory MCP tool**（可选，Phase 2）
   - `nanoclaw-memory-search` — 搜索 memory 文件
   - `nanoclaw-memory-write` — 写入 memory
   - 比 bash + write 更结构化，但 Phase 1 不需要

### 不做的

- ❌ 向量搜索 / embedding 索引 — 太复杂，先用关键词 grep
- ❌ Dreaming / 自动提升 — 先用每日 cron 汇总
- ❌ 跨 group memory — 每个 group（chat）独立 memory
- ❌ Memory wiki — 先只做纯 markdown

## Implementation Plan

### Phase 1: 基础 memory（文件 + skill）
- 创建 `container/skills/memory/SKILL.md`
- 在 agent system prompt 里注入 `MEMORY.md` + 今天/昨天的日记
- Agent 用 bash/write tool 读写 memory 文件

### Phase 2: 每日汇总 cron
- 在 nanoclaw 主进程里加定时任务
- 每天凌晨 spawn 临时 agent session 做汇总
- 读当天日记 → 更新 MEMORY.md

### Phase 3: Memory MCP tool
- `nanoclaw-memory-search` — grep + 简单关键词匹配
- `nanoclaw-memory-write` — 结构化写入
- 比 bash 更安全（不会误删文件）

### Phase 4: 向量搜索（如果需要）
- 用 embedding provider 索引 memory 文件
- 语义搜索替代关键词 grep

## Config

```json
"memory": {
  "enabled": true,
  "injectToPrompt": true,
  "dailySummary": {
    "enabled": true,
    "time": "02:00"
  }
}
```

## 与 GHC/CC 自身 memory 的关系

- **GHC CLI** 有 `~/.copilot/session-state/` 但没有跨 session 的 memory
- **Claude Code** 有 `CLAUDE.md` 作为 project instructions 但不是 memory
- NanoClaw 的 memory 是**补充**，不冲突。通过 system prompt 注入，agent 能看到但不会覆盖 CLI 自己的机制

## SDK Compatibility (spike 2026-04-19)

**Both runners expose symmetric hook APIs that make memory injection clean and runner-agnostic.**

### CC (Claude Agent SDK)
- File: `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- `systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' }` — static append at session creation (line ~1372)
- `SessionStartHook` → `SessionStartHookSpecificOutput.additionalContext` (line ~2805) — runtime per-session injection (`source: 'startup' | 'resume' | 'clear' | 'compact'`)
- `UserPromptSubmitHook` → `UserPromptSubmitHookSpecificOutput.additionalContext` (line ~4377) — per-turn injection

### GHC (`@github/copilot/sdk`)
- File: `container/agent-runner-ghc/node_modules/@github/copilot/sdk/index.d.ts`
- `QueryHooks.sessionStart` → `SessionStartHookOutput.additionalContext` (line ~34683) — `source: 'startup' | 'resume' | 'new'`
- `QueryHooks.userPromptSubmitted` → `UserPromptSubmittedHookOutput.additionalContext` (line ~38460); also exposes `modifiedPrompt` for prompt rewriting

### Decision
- **Phase 1 injection mechanism**: `sessionStart` hook in BOTH runners returning `additionalContext` containing `MEMORY.md` + today/yesterday's `memory/YYYY-MM-DD.md` content. Single shared abstraction in host, two thin runner adapters.
- **Phase 1.5 (cheap follow-up)**: `userPromptSubmitted` hook for per-turn memory refresh (so memory edits during the session take effect on the next turn without restarting).
- **No need for `systemPrompt` append fallback** — both SDKs have proper hooks. Skip the `COPILOT.md` mutation hack proposed in earlier draft.
- **No conflict with rpi5's `usage_stats` work** — usage uses post-event observers (`assistant.usage` for GHC, result message for CC), memory uses pre-turn hooks. Orthogonal.

## Decoupling Constraint (kenan, 2026-04-19)

> *“nanoclaw ghc fork 版本需要时长从 upstream 同步，如果耦合性太强，不方便 merge。之前我们说过这点，用 extension 的形式实现解耦。”*

**Implication for Phase 1**: do NOT edit `container/agent-runner/src/index.ts` (it tracks upstream `qwibitai/nanoclaw`). Editing it costs us a merge conflict on every upstream sync.

**Phase 1 ships using host-side composition only** — the host reads the per-group memory, appends it to the global system prompt template (`CLAUDE.md` / `COPILOT.md`), writes the result to a per-spawn temp file under `<groupDir>/.nanoclaw-system-prompt.<pid>.md`, and re-points the existing `NANOCLAW_GLOBAL_CLAUDE_MD` env var at that file. Both runners already honour the env var (existing fork patch), so memory injection is **fully transparent to upstream**.

**Phase 1 limitation**: only `agents.defaults.mode === 'host'` paths get memory injection. Container mode (`src/container-runner.ts`) doesn't propagate `NANOCLAW_GLOBAL_CLAUDE_MD` and would need its own bind-mount story — deferred to Phase 1.5 / 2.

**Future hooks** (Phase 1.5+): if we *do* need runtime injection (per-turn refresh, post-compact), we'll vendor a small extension shim that the runners load via a *single, narrow* upstream-friendly hook surface (one env var pointing at a JS module exposing `sessionStart` / `userPromptSubmitted` callbacks). That patch is small enough to maintain across upstream syncs. We're explicitly NOT shipping that yet.

# Compaction (Context Compression) for NanoClaw Agents

## Status: PROPOSAL (research / scoping)

## Overview

让 NanoClaw 的 agent runner（GHC + CC）支持 **context compaction** — 当 conversation 历史接近 model context window 上限时，自动把旧消息压缩成 summary，让 session 可以继续而不撞 token 上限。

模仿 OpenClaw / Claude Code / Cursor 的做法，但要看 **GHC SDK 和 CC SDK 暴露了什么 API**（这是 kenan 提到的"基于 ghc 或 cc 可能不好做"的核心顾虑）。

---

## OpenClaw 的做法（参考）

OpenClaw 直接控制 LLM API 调用，所以 compaction 是**完全客户端**实现：

1. **触发**：客户端估算当前 prompt token 数 vs model 上限（默认 75-85% 触发，或用户 `/compact` 手动）
2. **打包**：把对话历史拼成一个特殊 prompt：「下面是一段对话，请用 ~2k tokens 写一份保留所有关键决策、文件路径、代码片段、用户偏好的 summary」
3. **调用 LLM**：发一次普通 completion 请求拿 summary
4. **替换历史**：把原 N 条消息替换成 1 条 `<previous_conversation_summary>...</previous_conversation_summary>` system message
5. **下次 turn**：用新的短 prompt 继续，cache hit 暂时跌到 0%（prefix 重写了），慢慢回升
6. **计数器**：`Compactions: N` 显示在 status

---

## NanoClaw 的难点：我们不直接控制 LLM 调用

NanoClaw agent runner 是 SDK wrapper：
- **GHC runner** 用 `@github/copilot` SDK
- **CC runner** 用 `@anthropic-ai/claude-code` SDK

两个 SDK 都**封装了** session / conversation 状态管理。我们传 prompt 进去、收 events 出来，但**中间的 messages 数组、token 估算、prompt assembly 都在 SDK 内部**。

所以 OpenClaw 的"打包历史 → 调用 LLM 写 summary → 替换历史"流程在 NanoClaw 不能直接复刻。

---

## 调研问题（要回答才能定方案）

### Q1: GHC SDK / CC SDK 自己有 compaction 吗？
- CC SDK 实测：长对话会自己 compact（Claude Code 桌面版有 `/compact` slash command）→ 我们大概率**不需要做**，可能只需要透传一个 `/compact` 入口。
- GHC SDK 实测：未知。需要看 SDK 源码 / 文档有没有 `compact()` / `summarize()` API 或 auto-compact 配置。

### Q2: SDK 暴露当前 token 数吗？
- 如果 SDK 暴露 `getTokenCount()` / `getContextUsage()` → 我们能在 nanoclaw 层显示「context: N/200k」，触发 user-side 提醒
- 如果不暴露 → 我们只能从最近一次 response 的 `usage` 字段反推估算

### Q3: SDK 暴露 reset / new-session-with-context 吗？
- 如果 SDK 有 `session.reset(initialContext: string)` → 我们可以**模拟** compaction：
  1. 让 agent 在退出前把"我刚才在做什么"写到 `~/.nanoclaw/groups/{group}/.context-handoff.md`
  2. nanoclaw 读 handoff 文件
  3. 起新 session，把 handoff 注入新 system prompt
- 如果不暴露 → 只能 kill + spawn fresh，丢上下文

### Q4: 我们的 IPC 层卡在哪？
- agent 容器是 **task container**：起来跑一个 conversation 直到结束 / timeout
- 长对话场景下，我们已经有 `groupFolder` 持久化，但 conversation **history 在 SDK 内存里**，没落盘
- 如果想做 cross-container compaction，必须有"sdk session export"和"sdk session import"

---

## 候选方案（按可行性排）

### Plan A — 透传 SDK 自带的 compact（首选）
- 实测 CC SDK 是否有 `client.compact()` 或类似 API
- 实测 GHC SDK 是否有等价
- 在 nanoclaw 加 `/compact` slash command（我们已经有 slash 框架）
- 在 status 加 `Context: N/200k` 显示（如果 SDK 暴露）
- **工作量**：1-2 天 if SDK 支持，否则降级到 Plan B

### Plan B — 我们自己做 handoff-based 软 compaction
- agent 触发：写 `.context-handoff.md`（agent 自己用 write tool）
- nanoclaw 触发：spawn 新 container，把 handoff 文件路径放进 system prompt
- 加 `nanoclaw_compact()` MCP tool，agent 主动调用
- 加 token estimator（基于 file 行数粗估，不需要精确）
- **工作量**：3-5 天，包含 MCP tool 注册 + 容器 lifecycle 改

### Plan C — 不做 compaction，强制 short conversations
- 单 task container 寿命短（< N turn），到点 graceful shutdown，下条消息起新 container
- 把"长上下文"责任完全推给 memory 系统（features/memory.md）
- **工作量**：~半天，但 UX 退步（用户每隔几分钟就丢上下文）

---

## 推荐路径

## Research findings (2026-04-18)

### GHC SDK — Plan A 已确认

```ts
// node_modules/@github/copilot/sdk/index.d.ts:1979
export declare interface CompactionResult {
  success: boolean;
  tokensRemoved: number;
  messagesRemoved: number;
  summaryContent: string;
  contextWindow?: {
    tokenLimit: number;       // ← model context window
    currentTokens: number;    // ← live usage → 'Context: N/M' status
    messagesLength: number;
    systemTokens?: number;
    conversationTokens?: number;
    toolDefinitionsTokens?: number;
  };
}

// Events emitted by the SDK
CompactionStartedEvent = { kind: 'compaction_started', turn, performedBy, ... }
CompactionCompletedEvent = { kind: 'compaction_completed', compactionResult, ... }
```

Integration plan for GHC:
1. In `src/runners/ghc-runner.ts`, subscribe to compaction events
2. Maintain `compactionCount` per session in nanoclaw process state
3. Expose `Context: <currentTokens>/<tokenLimit>` and `Compactions: <n>` via status surface (sister proposal `features/status-cache-stats.md` / PR #12 renders them)
4. Add `/compact` slash command — SDK exposes `compactHistory(): Promise<CompactionResult>` on `Session`, `RemoteSession`, and the abstract base in `@github/copilot/sdk/index.d.ts` (verified on `@github/copilot@1.0.24`; line numbers drift across versions, anchor by symbol). Wire `/compact` directly to this method, await result, surface `tokensRemoved` / `messagesRemoved` to user.
### Source-of-truth coordination with PR #12

Per Rpi5's review nit: when both `CompactionResult.contextWindow.{tokenLimit,currentTokens}` and `assistant.usage` events emit context numbers, **prefer `CompactionResult.contextWindow`** (authoritative post-compaction snapshot from SDK), fallback to summing `assistant.usage` deltas, fallback to model registry static `tokenLimit`. PR #12 status renderer should use the same priority order to avoid `Context: N/M` mismatch between `nanoclaw status` and post-compact summary line.

### CC SDK — pending probe

Day 1 tasks:
- grep `node_modules/@anthropic-ai/claude-code` for `compact|summari|context_window`
- run a long CC session locally and watch for any compact events
- check `claude-code` CLI for `/compact` slash entry
- worst case: Plan B for CC, Plan A for GHC

## Path forward

1. **Day 1（半天）**：调研 — 跑 CC SDK 看 `/compact` 入口暴露在哪、跑 GHC SDK 找 token usage / compact API
2. **Day 1（剩下时间）**：写一份 `RESEARCH-FINDINGS.md` 钉到这个 proposal 上
3. **Day 2 决策点**：根据 findings 选 Plan A / B / C，更新 status: TODO → IN PROGRESS
4. **Day 3-5 实现 + 测试**

---

## 验收标准（Plan A 下）

- [ ] `nanoclaw status` 显示 `Context: N/M` 当 SDK 暴露
- [ ] `/compact` slash command 在 chat surface 工作（Telegram/Teams/Discord）
- [ ] Compaction 成功后下一条消息 agent 仍记得当前任务（不重复问"我们在做什么？"）
- [ ] Compaction 失败时降级到「写 handoff + 起新 container」
- [ ] docs/troubleshooting.md 写一段 "Compaction & long conversations"

---

## Open questions for kenan

1. 你在哪个 channel 最常碰到撞 context 上限？（决定 channel 优先级）
2. 你能接受"compaction 后 agent 偶尔忘记 5 分钟前的细节"吗？还是要求零信息丢失？
3. 这个 feature 的 priority vs file-handling / busy-ack / abort triggers？

---

_Proposed by: VM Claw, 2026-04-18_
_Companion proposal: `features/status-cache-stats.md` (Rpi5 Claw)_

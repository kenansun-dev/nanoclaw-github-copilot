# Status: Cache & Token Stats

## Status: TODO (proposal)

## Overview

让 `nanoclaw status` 显示 token 用量、cache 命中率、quota 余额——参照 OpenClaw `/status` 的信息密度，让用户对每次对话的成本和缓存健康度一眼可见。

是 [`compact.md`](./compact.md) 的姐妹 proposal：compact 让 nanoclaw 能控制上下文长度，cache stats 让用户能看出**什么时候**该 compact（cache hit 突然跌、context 接近上限）。

## OpenClaw 的做法（参考）

OpenClaw `/status` 的输出大概长这样：

```
🧮 Tokens: 6 in / 728 out
🗄️ Cache: 100% hit · 1607.2m cached, 84k new
📚 Context: 87k/200k
📊 Usage: Premium 100% left · Chat 100% left
📚 Compactions: 1
```

数据来源：

- **token / cache / cost / quota**：来自 LLM provider 的 API response（Anthropic 在 `usage` 里返回 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`），OpenClaw 客户端聚合
- **context 估算 / compaction 次数**：100% 客户端自己跟踪

OpenClaw 把每次 turn 的 usage 累加到 session 总量，cache hit 算 `cache_read / (cache_read + input + cache_create)`，quota 来自 provider 单独的 quota endpoint。

## NanoClaw 的现状

`nanoclaw status` 今天只显示 session 内部信息（group、container 状态、最近活跃时间等）。**完全没有** token / cache / quota 行。用户没法判断：

- 今天这个 group 烧了多少 tokens / 多少钱
- cache 是不是健康（hit rate 高不高）
- Premium quota 还剩多少
- 上下文有没有快满（什么时候该 `/compact`）

## 调研：GHC SDK 是否暴露这些数据

**结论：✅ 完全暴露**。

GHC SDK (`@github/copilot-sdk` v0.2.0) 通过 `assistant.usage` 事件给出每次 model call 的完整指标。Schema 定义在 `node_modules/@github/copilot/sdk/index.d.ts:769` (`AssistantUsageEventSchema`)，关键字段：

- `inputTokens` / `outputTokens` — 这次 turn 的 in/out tokens
- `cacheReadTokens` — cache 命中的 tokens（对应 OpenClaw 的 "hit"）
- `cacheWriteTokens` — cache 新写入的 tokens（对应 "new"）
- `reasoningTokens` — thinking model 的 reasoning tokens（单独计费，値得在 status 里单独显示）
- `cost` — 本次 turn 的成本
- `duration` / `ttftMs` / `interTokenLatencyMs` — 延迟数据
- `quotaSnapshots` — per-model 配额快照（`isUnlimitedEntitlement`、`entitlementRequests`、`usedRequests`、`remainingPercentage`、`resetDate`）
- `copilotUsage.totalNanoAiu` — CAPI 计费单位（nano-AIU）
- `reasoningEffort` — 当前 reasoning level

SDK 注释原文："Emitted in app.tsx's `onModelCallSuccess` callback" — 即每次成功的 model call 后由 GHC CLI 主动 emit。

我们的 `agent-runner-ghc` 已经在订阅 `assistant.message_delta` / `assistant.reasoning_delta`，加一行 `session.on('assistant.usage', ...)` 就能拿到。**0 处现存订阅，是 greenfield**。

字段名是 **camelCase**（`cacheReadTokens` 而不是 Anthropic 原生的 `cache_read_input_tokens`）— SDK 帮我们 normalize 了。

CC SDK（如果未来支持）也有类似 `usage` 字段在 message response 里（Anthropic SDK 标准 `usage` 对象），按同一套抽象统一。

## 设计

### 数据流

```
agent-runner-ghc (container)
  └─ session.on('assistant.usage') → IPC msg {type:'usage', data:{...}}
       │
       ▼
nanoclaw host
  └─ usage-tracker
       ├─ append to per-session usage log
       ├─ aggregate per-group / per-day / per-month totals
       └─ track latest quota snapshot per model

nanoclaw status
  └─ render token/cache/quota lines from aggregated data
```

### 显示格式（提案，可调）

```
$ nanoclaw status
[…现有字段…]

🧮 Last turn (claude-opus-4.7)
   Tokens: 4.2k in / 612 out / 1.8k reasoning · 38ms TTFT
   Cache: 92% hit · 1.2M lifetime cached · 320 new
   Cost: $0.034 (turn) · $1.27 (today) · $24.10 (month)

📊 Quota
   Premium: 89% left (445/500) · resets 2026-04-30
   Chat: unlimited

📚 Context
   ~38k tokens · compaction at ~150k for opus-4.7  (compactions: 0)
```

### Cache hit % 算法

跟 OpenClaw 一致：

```
hit_pct = cacheReadTokens / (cacheReadTokens + inputTokens + cacheWriteTokens)
```

表达"这次输入有百分之几从 cache 读出来"。

### 与 compact proposal 的协调

- `compact.md` 做的是 **客户端 compact 实现**（如果 nanoclaw 自己 compact 而不依赖 GHC CLI 内部）
- 本 proposal 做的是 **数据采集 + 展示**
- 集成点：GHC SDK 已经提供完整 first-class compaction API—`session.compactHistory()` method + `compaction_started` / `compaction_completed` events + `CompactionResult { tokensRemoved, messagesRemoved, summaryContent, contextWindow }` 接口 + `session.usage_info` event。本 proposal 的 "Compactions: n" 计数器直接订阅 `compaction_completed` event 增量。CC SDK 端起初未探测到等价符号，标 `Compactions: n (GHC) / n/a (CC pending SDK probe)`。

### 不做的（首版）

- ❌ 历史趋势图 / 月度报表（先做实时 status，趋势走 `nanoclaw status --daily` 后续）
- ❌ 多 provider 对比（先只 GHC，CC SDK 实装时再加 abstract layer）
- ❌ Per-tool token 分配（GHC SDK 不暴露这粒度）
- ❌ 推送 cost 警报（`status` 是 pull 命令，alert 走别的 feature）

## Implementation Plan

### Phase 1：数据接入
- agent-runner-ghc 加 `session.on('assistant.usage')` handler，IPC 转发到 host
- host 加 `usage_log` 表（per-turn raw event 落库）
- 加 feature flag `NANOCLAW_USAGE_TRACKING=1` dark launch

### Phase 2：聚合 + status 显示
- per-session / per-group / per-day / per-month 累加
- `nanoclaw status` 加 token / cache 行
- quota 快照独立存表（latest-known per model）

### Phase 3：完整渲染
- quota 行 + context 行
- `nanoclaw status --group <jid>` 过滤单 group
- `nanoclaw status --vacuum-usage older-than 90d` 清理

### Phase 4（可选）：性能数据
- `nanoclaw doctor` 加 TTFT / inter-token latency 显示，便于排查慢响应

## Config

```json
{
  "usageTracking": {
    "enabled": true,
    "vacuumAfterDays": 90,
    "showCostInStatus": true,
    "currency": "USD"
  }
}
```

环境变量：
- `NANOCLAW_USAGE_TRACKING=1` — 启用（Phase 1 dark launch 用）
- `NANOCLAW_USAGE_HIDE_COST=1` — 不在 status 显示金额（隐私场景）

## Open Questions

1. **成本数据源**：SDK 同时给 `cost`（USD？需验证）和 `copilotUsage.totalNanoAiu`（CAPI 计费）。优先用哪个？需要跑一次实际 turn 检查 payload 才能确定。
2. **存储增长**：每 turn 一行，1000 turns/day = ~365k rows/year ≈ 50MB SQLite。要不要默认开 `vacuumAfterDays: 90`？
3. **Privacy**：`raw_json` 含 `apiCallId` / `providerCallId`。本地 DB OK，但 telemetry / 错误上报必须 redact。
4. **Multi-account**：如果 nanoclaw 一个 host 跑多个 GitHub account（不同 token），quota 是按 account 分的。现在 `quotaSnapshots` 字段够用吗？还是要加 account 维度？

## Priority

中等。优先级 vs 其它：

- 低于：file handling fix（已完成）/ abort（PR #9 in flight）—— 这些是阻塞性 bug
- 等于：compact proposal —— 姐妹 feature，可以前后脚做
- 高于：per-tool token breakdown 等 nice-to-have

建议在 PR #9 merge 后开 `feat/status-cache-stats` 实现 Phase 1。

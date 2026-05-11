# Proposal: 让 scheduled task 不再占用主会话 (chat container)

> Author: rpi5 (draft) + VM (root-cause analysis, blame verification) | Date: 2026-05-11 | Status: **v3 — owner-aligned, scoped down to ~4-5h**

## v3 Changelog (2026-05-11 21:35 GMT+8)

owner kenansun 拍板 4 个方向，scope 收紧：

1. **复用现有 `ScheduledTask.context_mode: 'group' | 'isolated'`** (`types-extensions.ts:89`，DB 已有列) — 不加新字段，不动 schema，不动 `nanoclaw.json` config
2. **同 chat 多 task 并行** (跟 OpenClaw 对齐)，受全局 `MAX_CONCURRENT_CONTAINERS` 兜底 — 不再 per-chat 串行
3. **不加 `📋` prefix，不强制格式** — task 输出什么发什么，跟现在保持一致
4. **不引入新 `task-result/<id>.json` IPC 协议** — task 走现有 `sendMessage` outbound 路径

OpenClaw 命名对齐：我们的 `context_mode: 'isolated'` ↔ OpenClaw cron `sessionTarget: "isolated"`。仅注释说明，不动 schema。

工作量：~10h → **~4-5h**。

## 1. 问题 (TL;DR)

当 scheduled task 在某个 chat 触发 (cron / interval / once)，nanoclaw 把它送进**这个 chat 的 group container**。在 task 跑的整个时间里：
- `state.isTaskContainer = true`，`sendMessage()` **返回 false**，用户在这个 chat 发的消息**不能 IPC 进 agent**
- 用户能看到 typing indicator 偶尔闪一下，但 agent 不回话——直到 task 终结、container 退出，新 container 起来才接用户消息
- 表现：「主 session 被 task 占住，bot 不说话」

## 2. 是上游行为吗？是 (upstream design choice, 非 fork 改动)

**Git blame 验证 (VM 提供, 2026-05-11)**:
- `src/group-queue.ts` introduced upstream by gavrielc (commits `eac9a6a` / `ae17715`, upstream PR #111)
- `src/task-scheduler.ts` introduced upstream by gavrielc (commit `17e7b46`)
- `git diff upstream/main -- src/task-scheduler.ts src/group-queue.ts` = **0 行差异**
- 我们 fork 没改这块（除 logger 重命名）

**完整 occupation 路径有两层 lock，都是 upstream 设计**：

### Layer 1: Per-chat_jid 单 slot serialization (root cause)

`GroupQueue` 对每个 `chat_jid` 维护一个 `state`，**同一时间只能 1 个 active container**：
- 用户消息 → `enqueueMessageCheck(chat_jid)` (`group-queue.ts:120`)
- Scheduled task → `enqueueTask(task.chat_jid, ...)` (`task-scheduler.ts:322`)
- 两者共享同一个 chat_jid 的 queue slot
- task 跑时 `state.active = true`，user 消息进 `pendingMessages`，等 task 跑完 `drainGroup` 才被处理
- → 这才是「task 占主 session 不说话」的根本：scheduled task 用的就是目标 chat 的 chat_jid，task = main chat session 本人

### Layer 2: isTaskContainer 拒收 IPC (symptom path)

即便 task container 已经 spawn 起来在跑，user 想给它 IPC 一条 follow-up 也不行 (`group-queue.ts:162`):

```ts
sendMessage(groupJid, text): boolean {
  if (!state.active || !state.groupFolder || state.isTaskContainer)
    return false;
  ...
}
```

修方案要同时拆这两层：让 task 用独立 key 离开 chat_jid 的 slot，user 那个 slot 永远空着接消息。

## 3. OpenClaw 怎么做？

OpenClaw 在 `src/tasks/` + `src/cron/` 下做了 detached background task runtime：

- cron job 每条记录有 `sessionTarget: "main" | "isolated" | "current" | "session:<id>"` 字段，存在独立 state 文件 `~/.openclaw/cron/jobs.json`（**不在 config 里**），通过 `cron` tool 创建/管理
- `detached-task-runtime.ts`：task 跑在独立 isolated agent session，不占用 main session
- task 完成结果通过 delivery 配置（`announce` / `webhook`）push 回，可走 chat channel，也可不通知

**关键 takeaway**：runtime state 在 DB / jsonl，**不污染 config**。我们应该完全照抄这个设计。

## 4. 提议的方案 (v3 scoped)

**核心思路**：把 scheduled task 从「占用主 chat 的 container」改成「跑在 chat 之外的 detached task container」，task 完成后照旧通过 `sendMessage` 把结果送回 chat。

### 4.1 改动

#### A. group-queue.ts (rpi5 owns)
- 引入 `taskContainerKey = "${groupJid}::task::${taskId}"`，task container 用这个 key 而不是 `groupJid`
- `state` map 用 `taskContainerKey` 索引，**不与 groupJid 冲突**
- 主 chat 的 `state.isTaskContainer` 永远不再被 set true
- `sendMessage(groupJid, ...)` 永远 route 到 chat container（不再被 task 借走）
- 同 chat 多个 task 并行允许，受全局 `MAX_CONCURRENT_CONTAINERS` 闸门
- task container 退出时清掉自己的 `state` 条目，不影响 chat slot

#### B. task-scheduler.ts + host-runner.ts (VM owns)

> **📢 Correction (2026-05-11 22:15, post-implementation)**: 原 v3 说
> `context_mode` 控制 slot 路由 — 错。读代码后（`task-scheduler.ts:196`）发现
> `context_mode` 其实控制**sessionId 复用**：`'group'` 让 task agent
> 继承 chat 当前 session id（≡ OpenClaw cron `sessionTarget: 'current'`），
> `'isolated'` 走全新 session。与 slot 路由无关。
>
> **实际设计**：§4.1.A 后所有 task 都 detached，`enqueueTask` 统一创建
> `taskSlotKey(chatJid, taskId)` slot，不需要 `context_mode` 分流。

- 不需要改 `enqueueTask`的 slot 路由（§4.1.A 已统一走 detached）
- `context_mode` 保留作为 sessionId 复用开关，不动语义
- VM 提到的 3 个 host-runner gap 一并修：
  1. `ensureDailySummaryTask` 默认 `context_mode='isolated'`（新 task 同 session 语义上跳出 chat）
  2. host mode `processName` task-scoped：`nanoclaw-task-${taskId}-${ts}` vs chat 的 `nanoclaw-host-${groupFolder}-${ts}` — 方便运维 grep 区分
  3. §553 chat-wedge race：detached 后 wedge 自然消失（chat slot 一直空），注释记录该 race 在 detached 岶构下不再 wedge user chat

#### C. index.ts → outbound (VM 顺手)
- task 的 agent 输出**走现有 `sendMessage` outbound 路径**，不引入新 IPC 协议
- 输出格式跟现在一致，**不加 prefix、不加 footer**

#### D. config / schema
- ❌ **不动** `nanoclaw.json` config — 没有新字段
- ❌ **不动** DB schema — `context_mode` 列已存在 (`types-extensions.ts:89`)
- ✅ task 创建/管理路径（CLI 或 API）默认 `context_mode='isolated'`，用户/agent 想要旧行为显式传 `'group'`

#### E. CLI
- `nanoclaw tasks list` 区分 task container 与 chat container
- `nanoclaw tasks kill <taskId>` 只杀 task，不影响 chat

### 4.2 同 chat 多 task 撞车

**v3 决定：并行**（owner 拍板，跟 OpenClaw 对齐）。
- 每个 detached task 有自己的 `taskContainerKey` slot，互不挡
- 共享 `groupFolder` 写冲突？group folder 现在就是 mtime-based 自然 pick up，task 之间也通过同样机制收敛。真有 race 那是 task 实现 bug，不该用串行兜底
- 全局 `MAX_CONCURRENT_CONTAINERS=5` 仍然兜底，不会爆

## 5. 兼容/迁移

- 不动 v2 schema、不动 IPC 协议、不动 config
- 默认 `context_mode='isolated'` (新行为)，老 task 在 DB 里还是默认值，自动走新 codepath
- 撞 bug：单 task 改 `context_mode='group'` 临时回退，或全局 env (`NANOCLAW_TASKS_FORCE_GROUP=1`) 一键回退到旧行为

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Task container 抢占 docker / RAM | 全局 `MAX_CONCURRENT_CONTAINERS` 闸门已存在 |
| Task 写 group folder 与 chat container 冲突 | 现有 mtime-based 收敛机制，与今天 chat container 之间 spawn/exit 共享同一 folder 是同样问题，没新增 |
| Task 想"问用户后续"的 (interactive) | 写 task 时设 `context_mode='group'` fall back 到旧行为 |
| Host mode 怎么办 | 锁不在 docker 那层，是在 `GroupQueue`；host mode 与 container mode 受益相同，detached 后 chat slot 都解放 |
| §553 chat-wedge race | detached 后 chat slot 永不被 task 占，wedge 自然消失（VM PR comment 标注） |

## 7. 工作量估计 (v3)

- group-queue 改造（rpi5）：~1.5 小时
- task-scheduler `context_mode` 分流（VM）：~1 小时
- 3 host-runner gap（VM）：~1 小时
- 测试：~1.5 小时（unit + e2e detached task 跑过）

**总计 ~4-5 小时**。一个 daily PR `chore/2026-05-11-detached-tasks` 完成。

## 8. Decisions locked (owner-confirmed 2026-05-11 21:35)

| # | 决策 | 状态 |
|---|---|---|
| 1 | 默认 `context_mode='isolated'`，`'group'` 留作 opt-in fallback | ✅ owner |
| 2 | 同 chat 多 task **并行**（不串行） | ✅ owner |
| 3 | task 输出**不加 prefix、不限格式**，跟现在一致 | ✅ owner |
| 4 | **不动 config，不动 schema**，复用现有 `context_mode` 列 | ✅ owner + VM |
| 5 | 不引入新 IPC 协议，task 走现有 `sendMessage` | ✅ VM |
| 6 | OpenClaw 命名对齐（`isolated` ↔ cron `sessionTarget: isolated`）仅注释 | ✅ VM |

## 9. 分工

- **rpi5**: §4.1.A group-queue + 这份 doc 维护
- **VM**: §4.1.B task-scheduler + §4.1.C outbound 路径 + 3 host-runner gap

一个 daily PR：`chore/2026-05-11-detached-tasks` (branch 已开，HEAD = main `75dcfb7`)。

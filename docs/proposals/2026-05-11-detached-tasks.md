# Proposal: 让 scheduled task 不再占用主会话 (chat container)

> Author: rpi5 (draft) + VM (root-cause analysis, blame verification) | Date: 2026-05-11 | Status: draft for owner review

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
- `git diff upstream/feat/migrate-from-v1-- ...` = 0 行差异
- 我们 fork 没改这块（除 logger 重命名）

**完整 occupation 路径有两层 lock，都是 upstream 设计**：

### Layer 1: Per-chat_jid 单 slot serialization (root cause)

`GroupQueue` 对每个 `chat_jid` 维护一个 `state`，**同一时间只能 1 个 active container**：
- 用户消息 → `enqueueMessageCheck(chat_jid)` (`group-queue.ts:120`)
- Scheduled task → `enqueueTask(task.chat_jid, ...)` (`task-scheduler.ts:322`)
- **两者共享同一个 chat_jid 的 queue slot**
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

`isTaskContainer` 在 `runTask()` set true，task 完成 callback reset false。`MAX_CONCURRENT_CONTAINERS=5` 是全局并发上限，但**每个 chat 仍然只允许 1 个 container** —— 不是全局限的问题，是 per-chat 设计的问题。

**修方案要同时拆这两层**：让 task 用独立 key 离开 chat_jid 的 slot，user 那个 slot 永远空着接消息。

## 3. OpenClaw 怎么做？

OpenClaw 在 `src/tasks/` 下有完整的 **detached background task runtime**：

- `task-registry.ts`：task 注册到独立 SQLite registry，有 own runId / status / lifecycle
- `detached-task-runtime.ts`：task 跑在**独立 session** (isolated agent session)，不占用 main session
- `task-executor-policy.ts`：task 终结时把 summary push 回 main session 当一条 system event (`Background task done: <title>. <summary>`)
- 用户在 main session 里**永远能继续聊天**，task 进度通过事件 stream / 聚合状态查 (`openclaw tasks list`)

关键差异：OpenClaw 把 "scheduled work" 当成**与 user 平行的另一个 session**；NanoClaw 把它当成**user 那个 session 里的一次特殊 turn**。

## 4. 提议的方案

**核心思路**：把 scheduled task 从「占用主 chat 的 container」改成「跑在 chat 之外的 detached task container」，task 完成后把结果作为一条**普通 outbound message** 送回 chat。

### 4.1 改动

#### A. group-queue.ts
- 引入 `taskContainerKey = "${groupJid}::task::${taskId}"`，task container 用这个 key 而不是 `groupJid`
- `state` map 用 `taskContainerKey` 索引，**不与 groupJid 冲突**
- 主 chat 的 `state.isTaskContainer` 永远不再被 set true
- `sendMessage(groupJid, ...)` 永远 route 到 chat container（不再被 task 借走）
- `MAX_CONCURRENT_CONTAINERS` 同时限制 chat + task 总数（保留全局压舱石）

#### B. task-scheduler.ts → enqueueTask
- 改为 `enqueueDetachedTask(groupJid, taskId, fn)`
- 走新 codepath：spawn container 时用 `taskContainerKey`，给 agent 注入 metadata `{ taskId, taskName, groupJid, postBackChannel }`
- agent 完成后，结果不通过 `output.txt` 走 chat 流，而通过新 IPC `task-result/<taskId>.json`

#### C. index.ts
- 监听 `task-result/*.json`：把 result 当成 **outbound message** 发到 task 配置的 `chatJid`，**不是 chat container 的 reply**
- 在 chat 中显示成 `📋 Task <name> done: <summary>`（带 task icon 标记，用户看一眼知道是 scheduled task 自动出的，不是 reply）
- 失败/超时同样格式化（`❌ Task <name> failed: <error>`）

#### D. config
- 新增 `sandbox.tasksMaxConcurrent`（默认 = `maxConcurrent`，可独立调）
- 新增 feature flag `tasks.detached`（默认 true，可临时回退到旧行为）

#### E. CLI
- `nanoclaw tasks list` 显示 task container 状态独立于 chat
- `nanoclaw tasks kill <taskId>` 只杀 task，不影响 chat

### 4.2 何时同 chat 多个 task 撞车

旧行为下不可能（chat container 只能跑一个）。新行为下要决策：
- **方案 A（保守）**：同一 chat 串行——`task-queue.<groupJid>` FIFO，跑完一个起下一个
- **方案 B（激进）**：完全并行，受 `tasksMaxConcurrent` 全局限

**默认选 A**——避免 task 之间共享 workspace 写冲突，符合用户心智模型「这个 chat 的 task 一个一个跑」。B 留作未来 opt-in。

## 5. 兼容/迁移

- 不改 v2 schema、不改 IPC 协议（只新增一个 `task-result/` 目录）
- Feature flag 默认开，撞 bug 可一键关回旧行为
- 已 scheduled 的 tasks 自动走新 codepath，无需用户操作

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Task container 抢占 docker / RAM | `tasksMaxConcurrent` + 全局 `MAX_CONCURRENT_CONTAINERS` 双闸门 |
| Task 写 group folder 与 chat container 冲突 | 现有 group folder 写就是 mtime-based，task 完成 → flush → chat 下次 spawn 自然 pick up；同 chat 串行(方案 A) 更安全 |
| Task 想"问用户后续"的 (interactive) 现在变 outbound | 提案里所有 task 默认 non-interactive；要 interactive 的 task → 写 task config 时 fall back 到旧行为 (`task.requireMainSession: true`) |
| 上游有人想 merge 上去 | 整改在 fork-only `src/tasks-extensions.ts` + 最小 patch 上游文件，便于未来 PR upstream |

## 7. 工作量估计

- group-queue 改造：~3 小时
- task-scheduler / IPC：~2 小时
- index.ts outbound 渲染：~1 小时
- 测试：~3 小时（unit + 一个 e2e Telegram task case）
- 文档 + flag：~1 小时

**总计 ~10 小时**。一个 daily PR 能完成。

## 8. Open questions for owner

1. **方案 A vs B**（同 chat task 串行 vs 并行）默认选 A 你 OK？
2. Task 完成后的渲染：`📋 Task <name> done: <summary>` 这个格式 vs 你想要别的（例如 quoted reply / embed / silent log）？
3. 旧行为完全删掉 vs 保留 `task.requireMainSession: true` 作 fallback？我倾向**保留**（少数 task 可能确实想抢 chat session），你拍板。
4. 下个 daily PR 装这个，还是优先级再排？

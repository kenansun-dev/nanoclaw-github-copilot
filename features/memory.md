# Memory System

## Status: Phase 1 + Phase 2 SHIPPED (PR #14, 2026-04-19)

## Overview

让 NanoClaw agent 能跨 session 记忆——记住用户偏好、过去的决策、项目上下文。**Tool-based on-demand**，不是 system-prompt injection。模仿 OpenClaw 的 memory 系统。

## OpenClaw 的做法（参考）

- **`MEMORY.md`** — 长期记忆，持久的事实/偏好/决策
- **`memory/YYYY-MM-DD.md`** — 每日笔记（local time）
- **Tools**: `memory_search` / `memory_get` — agent 按需读，**不灌进 system prompt**
- **Dreaming** — cron 自动总结：light → REM → deep。只有 deep 阶段写 `MEMORY.md`
- 存储：纯 Markdown 文件

## 设计决定

### 走 OpenClaw 风格（tool-based），不灌 system prompt

第一版（已 revert）把 memory 全文塞进 `NANOCLAW_GLOBAL_CLAUDE_MD`，每次 agent 启动都吃这份 context。Kenan 在 2026-04-19 的反馈是 **overdesign**：

- 浪费 token：很多对话根本不需要 memory
- 不够 selective：agent 想 query 历史某条事实，得在已经塞进来的全文里找
- 颠倒主次：cron summarizer 才是 memory 的核心生产者，第一版反而推到 Phase 2

正确做法：**给 agent 工具，让它按需 search/read/append**。

### 与 GHC/CC 自身 memory 的关系

| 系统 | 存储 | scope | 写入 |
|---|---|---|---|
| **nanoclaw memory（本 feature）** | `<groupDir>/memory/*.md` | per-group（discord channel） | tool |
| CC `CLAUDE.md` 链 | `~/.claude/`, project, local | 全局/项目 | 用户手编 |
| CC `autoMemory` + auto-dream | `~/.claude/projects/.../memory/` | 项目 | CC 后台 |
| GHC `MemoryPermissionRequest` | GitHub 服务器 | 账号 | agent 申请 |

NanoClaw memory 是**补充**，不冲突：
- 不同存储路径
- 跨 agent 一致（CC + GHC 看同一份 group memory，是 nanoclaw 独有）
- per-group 隔离（discord channel 之间不串）
- CC 的 autoMemory 默认关，没有重叠
- GHC 的 service memory nanoclaw runner 没接

### 不做的（Phase 1）

- ❌ 向量搜索 / embedding 索引 — 关键词 grep 够用
- ❌ Dreaming 多阶段（light → REM → deep）— 一个简单 cron 总结就行
- ❌ 跨 group memory — 每个 group 独立
- ❌ 自动 system-prompt injection — agent 用工具按需读

## Phase 1 实现 (PR #14)

### Memory tools live inside the existing `nanoclaw` MCP server

5 new tools added to `container/agent-runner{,-ghc}/src/ipc-mcp-stdio.ts` (the existing `nanoclaw` MCP server that already hosts `send_message`, `schedule_task`, etc.). **Not a separate MCP server** — fewer processes, consistent `mcp__nanoclaw__*` namespace, zero upstream-tracked patch surface.

| Tool | 作用 |
|---|---|
| `memory_list` | 列 memory 文件（size, mtime, preview） |
| `memory_read` | 读指定 memory 文件（自动 head/tail truncate at 256KB） |
| `memory_search` | 跨所有 *.md 子串搜索（case-insensitive，±3 行 context，max 50 hit） |
| `memory_append_today` | append 一条带 local-time HH:MM 前缀的 bullet 到 `<today>.md` |
| `memory_promote` | 把 fact 提升到 `MEMORY.md` 指定 H2 section（默认 "Notes"） |

存储：
```
$NANOCLAW_MEMORY_DIR/  (defaults to <groupFolder>/memory/)
  MEMORY.md            ← long-term curated
  YYYY-MM-DD.md        ← per-day journal (local time)
  .dreams/             ← reserved for cron summarizer state
```

### 文件清单

| 文件 | 角色 |
|---|---|
| `src/memory/tools-impl.ts` | 纯函数 impl（canonical） |
| `src/memory/tools-impl.test.ts` | 19 单测 |
| `src/memory/cron.ts` | Per-group daily-summary cron registration (Phase 2) |
| `src/memory/cron.test.ts` | 2 单测（defaults pin） |
| `container/agent-runner{,-ghc}/src/ipc-mcp-stdio.ts` | +5 memory tool registrations in existing `nanoclaw` MCP server |
| `container/skills/memory/SKILL.md` | 教 agent 用工具的 skill 文件 |
| `src/host-runner.ts` | 设 `NANOCLAW_TZ` env + 调用 `ensureDailySummaryTask` |

### Local time 处理

所有日期用 `nanoclaw.json` 里 `timezone` 字段定义的时区：
- Host 把 `TIMEZONE` 设到 `TZ` + `NANOCLAW_TZ` 环境变量
- MCP server 用 `Intl.DateTimeFormat({ timeZone: NANOCLAW_TZ })` 格式化日期/时间
- `memory_append_today` 创建的文件名是 `<local-date>.md`
- 时间戳前缀也是 local time

### 解耦情况

**全部 fork-only。零 upstream-tracked 文件修改。**

| 文件 | upstream-tracked? | 改动 |
|---|---|---|
| `src/memory/tools-impl.ts` | ❌ FORK-ONLY | 新文件 |
| `src/memory/cron.ts` | ❌ FORK-ONLY | 新文件 |
| `src/host-runner.ts` | ❌ FORK-ONLY | +`NANOCLAW_TZ` + `ensureDailySummaryTask` 调用 |
| `container/agent-runner-ghc/src/ipc-mcp-stdio.ts` | ❌ FORK-ONLY | +5 memory tool 注册 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | ❌ FORK-ONLY | +5 memory tool 注册 |
| `container/skills/memory/**` | ❌ FORK-ONLY | 新 skill |
| `container/agent-runner/src/index.ts` | ✅ UPSTREAM | **零修改** — 上一版的 +37 行 auto-discover 已 revert |

为什么 ipc-mcp-stdio.ts 不是 upstream-tracked：git 验证过两份 `ipc-mcp-stdio.ts` 都是 fork-only（`git ls-tree upstream/main` 查不到）。Memory tool 加进去零耦合成本。

## Phase 2: 自动每日总结 cron (SHIPPED)

### How it works (end-to-end)

1. **Trigger**: 每次 host 准备 spawn agent 处理 group 消息，先调一次 `ensureDailySummaryTask({chatJid, groupFolder})` (idempotent)
2. **Ensure**:
   - 找不到 task → 用 default cron + prompt 创建（id = `memory-daily-summary:<chatJid>`）
   - 找到了 → 比较 cron + prompt 与当前 config，drift 了就 `updateTask` 在场更新，**不动** `status` / `last_run` / `last_result`（保留用户手动暂停 + 历史）
3. **Fire**: 到点了 NanoClaw 现成的 task scheduler（`cron-parser` + 配置的 `TIMEZONE`）按普通 task 一样 spawn agent，prompt 就是 default summary prompt
4. **Agent 行为**: prompt 让 agent 读今天 chat history，挑 3–7 个 highlight，**每个 highlight 单独调一次 `memory_append_today`**（每条独立 timestamp）
5. **结果**: 写进 `<groupDir>/memory/YYYY-MM-DD.md`，下次 agent 想回忆今天能 `memory_read` 拿到

复用现有 task scheduler 而不是新开 cron loop — 一种调度机制就够了。

### 为什么默认 23:45 local time（kenan · 2026-04-19）

- **23:45 而不是 00:00 之后**：summary 总结的是 **"今天"** 的 chat history。如果 cron 跨过午夜才 fire，agent 算"今天"是新的一天，会写空 journal 或写错日期。23:45 让 agent 在**还在当天**的时候完成总结。
- **23:45 而不是 23:55**：留 ~15 min buffer 给 agent 实际跑完（模型推理 + tool calls 可能 30s–2min）。23:55 fire 可能 00:00 才写完，当天 journal 拿不到这条。
- **不是 22:00 之类更早的时间**：用户晚上 22–23 点还可能在群里聊事，总结太早会漏掉这段。
- 想改？config 改 cron expression 即可，这值不是硬编码的限制，只是 sane default。

### Disable 路径的现状（**已知 sharp edge**）

`memory.dailySummary.enabled: false` 只让 `ensureDailySummaryTask` 早 return，**不会**修改已存在的 task — cron 还是会照常 fire。要真停掉得 `nanoclaw task cancel memory-daily-summary:<chatJid>`。

Rpi5 review 标记为 design 问题（[#1495347889784754176]），TODO：要么 disable=false 时把 task `status` 改成 `paused`，要么文档警示更显眼。

### 怎么配置（用户视角）

所有字段都可选，缺省走 default。改完 nanoclaw.json 后**下次 agent spawn 自动 pickup**（drift detection 会 in-place update 已有 task）。

```json
{
  "memory": {
    "dailySummary": {
      "enabled": true,
      "cron": "45 23 * * *",
      "prompt": "...optional override..."
    }
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 开关。**注意**：改成 false 不会删已存在 task，见上文 sharp edge |
| `cron` | `45 23 * * *` | 5段 cron，按配置的 `TIMEZONE` 解析。改 cron 下次 spawn 会同步到已有 task |
| `prompt` | 内置 | 触发时给 agent 的 prompt。改 prompt 同样下次 spawn 同步 |

常见想改的场景：
- **不想被半夜叫醒**：改 cron 到 `0 8 * * *`（早 8 点总结昨天）
- **想关掉**：先 `nanoclaw task cancel memory-daily-summary:<chatJid>` 取消已存在 task，**然后**才设 `enabled: false`
- **改 prompt**：注意保留"每条 highlight 单独 call `memory_append_today`"这条指令，不然 agent 会一次写完所有 bullets，每条共享同一个 timestamp

### Memory tools（agent 用的，5 个）

所有 tool 名字都是 `mcp__nanoclaw__memory_*`，scope 都是当前 group：

| Tool | 用途 |
|---|---|
| `memory_list` | 列 group 下所有 memory 文件（MEMORY.md + 每日 journal），含 size/mtime/preview |
| `memory_read` | 读某个文件（>256KB head/tail 截断） |
| `memory_search` | 跨所有 memory 文件 grep + 上下文 |
| `memory_append_today` | append 一行到今天的 `YYYY-MM-DD.md`，自动加 timestamp。**写错日期是常见 bug 来源 — 这个 tool 让 agent 不用自己算日期** |
| `memory_promote` | 把 daily 的内容"晋升"到 `MEMORY.md`（curated 长期记忆）。Agent 该 sparingly 用，只放跨天/跨周值得记的 |

## Phase 3+ (TODO)

- OpenClaw 风格的 light/REM/deep 多阶段 dreaming
- 跨 group memory search（仅当多 group 协作有需求）
- 向量搜索（仅当 corpus > 1000 文件且 grep 性能不行）

## 历史（实现踩坑记录）

- 2026-04-19 11:25 \[`6934e41`\] 第一版：host 把 memory 拼进 system prompt，临时文件 + env var hack。Kenan 反馈 overdesign。
- 2026-04-19 13:35 \[`8e4b395`\] 重做为 OpenClaw tool-based 风格，但独立 MCP server。
- 2026-04-19 13:55 \[本 PR\] Kenan 反馈：应该合进已有 `nanoclaw` MCP server。合并后 CC `index.ts` 补丁纯 revert，Phase 2 cron 同时 ship。23:45 local time、default enabled。

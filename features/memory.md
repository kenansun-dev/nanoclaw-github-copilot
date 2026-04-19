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

`src/memory/cron.ts` 提供 `ensureDailySummaryTask({ chatJid, groupFolder })`，被 `host-runner.ts` 在每次 spawn agent 时调用（幂等）。

- **默认 cron**: `45 23 * * *` （23:45 local time，kenan 钉的）
- **默认 enabled**: `true`
- **默认 prompt**: 内置（"总结今天 chat history，用 memory_append_today…"）
- **Drift detection**: 如果配置改了 cron 或 prompt，`updateTask` 在场更新，不动 status / last_run
- **Disable 路径**: `memory.dailySummary.enabled: false` — 不会删除已存在任务，需要手动 `nanoclaw task cancel`

### Phase 2 配置

```json
"memory": {
  "dailySummary": {
    "enabled": true,
    "cron": "45 23 * * *",
    "prompt": "...optional override..."
  }
}
```

## Phase 3+ (TODO)

- OpenClaw 风格的 light/REM/deep 多阶段 dreaming
- 跨 group memory search（仅当多 group 协作有需求）
- 向量搜索（仅当 corpus > 1000 文件且 grep 性能不行）

## 历史（实现踩坑记录）

- 2026-04-19 11:25 \[`6934e41`\] 第一版：host 把 memory 拼进 system prompt，临时文件 + env var hack。Kenan 反馈 overdesign。
- 2026-04-19 13:35 \[`8e4b395`\] 重做为 OpenClaw tool-based 风格，但独立 MCP server。
- 2026-04-19 13:55 \[本 PR\] Kenan 反馈：应该合进已有 `nanoclaw` MCP server。合并后 CC `index.ts` 补丁纯 revert，Phase 2 cron 同时 ship。23:45 local time、default enabled。

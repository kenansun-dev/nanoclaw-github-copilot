# Plan Mode & Active-Step UI

NanoClaw 套壳 CC 和 GHC 两个 SDK，需要决定：是 **leverage** 上游的 plan
mode / active-step 机制，还是 **自己实现** 一套统一抽象。

本文回答三个问题：

1. CC / GHC SDK 各自能回传什么 plan / step 信号？
2. 哪些信号 NanoClaw 在 channel 端 (TG / Discord / Teams) 能用？
3. 推荐方案是什么？

---

## TL;DR

| 维度 | CC SDK | GHC SDK |
|------|--------|---------|
| Plan mode tool 是否会触发 | ❌ 否（TUI-only — 见下方"为什么"） | ❌ 没有这个概念 |
| 能否拿到 step 列表 | ✅ 能（`TodoWrite` tool_use block 在 message stream 里） | ❌ 不能（SDK 不广播 tool 调用） |
| 当前 active step | ✅ 能（CC 用 `status: 'in_progress'` 字段） | ❌ 不能 |
| 自定义 tool 能否补救 | 可以但意义不大（已经有 `TodoWrite`） | ✅ 必须自定义 — 唯一通路 |

**结论**：

- **不要试图启用上游 plan mode**。CC 和 Claude Code 的 plan mode 都强依赖
  TUI dialog（`EnterPlanMode` 切换 `appState.toolPermissionContext`、
  `ExitPlanMode` 弹审批 dialog 让人按按钮拍板）。在 channel 模式下
  `isEnabled()` 直接 return false，根本不会被注册到 tool list 里。
- **DO leverage CC 的 `TodoWrite`** 渠道：CC SDK 把每个 `tool_use` block 完
  整暴露在 assistant message 的 content array 里，我们能直接读到 todos 数组，
  零成本拿到 step list + active step。
- **GHC 路径要自己实现**：通过 nanoclaw MCP server 注册一个 `nanoclaw__plan`
  custom tool，让模型主动汇报 plan/step。GHC SDK 完全不广播内置 tool 调用，
  只能走自己注册的 tool 路径。
- **统一抽象 `PlanState`**：CC adapter 从 TodoWrite 输入解析、GHC adapter 从
  custom tool handler 解析，都喂同一个 in-memory state，channel 端用同一段
  渲染逻辑（progressive editMessage / Discord embed）输出。

预估工作量：**AI 4-6 小时**（含两条 adapter + 渲染 + 测试）。

---

## 1. 上游 plan mode 究竟是什么（简版）

详细调研见 `~/.openclaw/workspace/projects/nanoclaw-copilot/research/claude-code-plan-mode.md`。

Claude Code 的 plan mode 是 **两个独立机制**叠加的：

### a) Plan mode 本身 = 权限模式开关

- `EnterPlanMode` tool 调 `setAppState({ toolPermissionContext: { mode: 'plan' } })`
- 权限系统看到 `mode === 'plan'`，自动 deny 所有写工具（Edit/Write/Bash/...）
- `ExitPlanMode` tool 弹一个 React Ink dialog，让用户按 `Approve` / `Reject`
  / `Replan` 按钮拍板
- **关键依赖**：`isEnabled()` 实现里 `if (getAllowedChannels().length > 0) return false`
  → 只要在 channel 模式（即非 TUI），这两个 tool 根本不在 model 可见的 tool
  列表里

→ **NanoClaw 不能直接 leverage**。我们的所有触达都是 channel-based。

### b) Active-step UI = `TodoWrite` + `TaskListV2` 渲染

- 完全独立的机制，**和 plan mode 没有耦合**
- model 主动调 `TodoWrite({ todos: [{ id, content, activeForm, status }] })`，
  每次都是**全量重写**整个 list（不是 patch）
- `status` 取值：`pending` / `in_progress` / `completed`
- TUI 端 Spinner 找 `currentTodo = todos.find(t => t.status === 'in_progress')`
  显示在 spinner 旁，TaskListV2 组件渲染整个 list（completed 灰色删除线，
  in_progress 粗体主题色，pending 灰色方块）
- **关键依赖**：仅 React Ink 渲染。但**数据本身是 SDK message stream 里的
  普通 tool_use block**，channel 端完全可以截取。

→ **NanoClaw 完全可以 leverage 这部分**（CC 路径）。

---

## 2. 各 SDK 实际能回传什么

### CC SDK — `query()` 异步迭代器

NanoClaw 的 `container/agent-runner/src/index.ts:461` 已经在 `for await` 这
些 message：

```ts
for await (const message of query({ ... })) {
  if (message.type === 'assistant') {
    // message.message.content 是 array，每个元素是 ContentBlock
    // 类型：'text' | 'thinking' | 'tool_use' | 'tool_result'
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        // ✅ block.input.todos 就是当前 plan 的全量快照
        // 包括 status === 'in_progress' 的 active step
      }
    }
  }
}
```

**目前 NanoClaw 没读这些块** — 只用了 `text` 块拼最终回复 + `thinking` 块
做 reasoning preview。加 plan 渲染只需要在 content-block loop 里多 case 一
个 `'tool_use'` 分支。

零额外 SDK 成本。

### GHC SDK — `session.on(eventName, cb)`

完整事件清单（grep `~/.npm-global/lib/.../copilot-sdk/session.d.ts`）：

```
'assistant.message'        ← 最终消息
'assistant.message_delta'  ← stream chunk
'assistant.reasoning'      ← 最终 reasoning
'assistant.reasoning_delta'← stream reasoning chunk
'session.idle'
'session.error'
'session.warning'
'session.info'
```

**没有任何 tool 相关事件**。GHC SDK 通过 RPC `tool.call` 让 server 回调
nanoclaw 注册的自定义 tool（`registerTools()`）—— 但 GHC **内置** tool
（FileEdit/Bash/etc）的调用我们看不到，只有 server 内部知道。

→ 即使 GitHub 自己有类似 plan mode（gpt-5.4 系列号称有 todo-style 规划），
我们也拿不到结构化的 step 数据。**唯一可行通路是自定义 MCP tool**。

---

## 3. 推荐设计

### 3.1 数据模型（统一抽象）

`src/plan/types.ts`:

```ts
export interface PlanStep {
  id: string;
  title: string;          // CC 的 content / GHC 的 step.title
  activeForm?: string;    // CC 的 activeForm（"Reading file X..." 给 spinner 用）
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface PlanState {
  chatJid: string;
  turnId: string;         // 每个 user message → 一个 turn → 一个 plan
  steps: PlanStep[];
  updatedAt: number;
}
```

存在 `src/plan/store.ts` 里的 in-memory map（不持久化 — turn-scoped）。

### 3.2 CC adapter（`src/plan/cc-adapter.ts`）

在 `container/agent-runner/src/index.ts` 的 message loop 里挂钩：

```ts
if (block.type === 'tool_use' && block.name === 'TodoWrite') {
  const todos = (block.input as { todos: any[] }).todos;
  const steps = todos.map(t => ({
    id: t.id ?? String(idx++),
    title: t.content,
    activeForm: t.activeForm,
    status: t.status, // 'pending'|'in_progress'|'completed'
  }));
  await sendIpc({ type: 'plan.update', steps });
}
```

`plan.update` IPC message 走和 `tool.call` 同一条管道，host runner 接收后
更新 `PlanState` 并触发 channel 渲染。

**零成本** — 数据本来就在 stream 里，CC 自己也是这么消费的。

### 3.3 GHC adapter — 自定义 `nanoclaw__plan` tool

在 nanoclaw MCP server (`src/mcp-server/`) 加一个 tool：

```ts
defineTool('nanoclaw__plan', {
  description:
    'Publish or update your execution plan so the user can see steps in '
    + 'real time. Call when starting a multi-step task (>3 steps) or when '
    + 'a step status changes.',
  parameters: z.object({
    steps: z.array(z.object({
      id: z.string(),
      title: z.string(),
      activeForm: z.string().optional(),
      status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    })),
  }),
  handler: async ({ steps }, invocation) => {
    await publishPlan(invocation.chatJid, steps);
    return { ok: true };
  },
});
```

加 system prompt 提示（仅 GHC 路径）：
> When the task has >3 distinct steps, call `nanoclaw__plan` with your
> current plan. Re-call it whenever a step status changes.

**注意**：CC 路径**不**注册这个 tool —— CC 用自己的 `TodoWrite`。
两条路径在 host runner 的 PlanState store 汇合。

### 3.4 渲染（channel 端）

复用现有 progressive editMessage 机制（已在 flash reasoning 用了）：

- TG: 一条单独的 message，编辑而不是新发；用 emoji + 删除线表示状态
- Discord: 用 embed，fields 列出 steps，progress bar 在 description
- Teams: Adaptive Card with FactSet

渲染 throttle 同 flash：`min(每秒1次, status变化时立即)`。

样例输出（TG）：

```
📋 Plan (3/5)
✅ ~~Read existing config~~
✅ ~~Identify model field~~
🔵 **Validate against catalog** ← 当前
⚪ Persist to nanoclaw.json
⚪ Reload runtime
```

### 3.5 触发条件（不要每个回复都搞 plan）

- CC：只要 model 调了 `TodoWrite`（model 自己决定值不值得）
- GHC：system prompt 让 model 自己决定 — 一行任务不要 publish

### 3.6 测试

- `cc-adapter.test.ts`：mock `tool_use` block，断言 PlanState 正确更新
- `ghc-mcp-tool.test.ts`：mock invocation，断言 publishPlan 被调
- `render.test.ts`：固定 PlanState → 比对输出文本快照

---

## 4. 不做什么（明确边界）

- ❌ 不试图开启 `EnterPlanMode` / `ExitPlanMode` —— TUI 强依赖
- ❌ 不 fork CC / GHC SDK 注入事件 —— 维护成本无底洞
- ❌ 不持久化 PlanState —— turn-scoped，turn 结束就清
- ❌ 不在每条消息都强制 model 出 plan —— 噪音

---

## 5. 风险

- **GHC model 不主动调 `nanoclaw__plan`**：system prompt 说不动它。
  缓解：先观察 prod 调用频率，必要时加 few-shot example
- **CC `TodoWrite` 全量重写**：每次拿到的是完整新 list，不是 diff。要在
  store 里 detect 状态变化做 throttle，避免 channel 刷爆
- **多 turn / parallel agent**：CC `parent_tool_use_id` 可以判断是子 agent
  调的；目前先只渲染 main turn 的 plan，子 agent 不显示
- **Channel 渲染失败 fallback**：渲染失败时静默降级（不影响主回复）

---

## 6. 决策点（等 review 拍板）

1. ✅/❌ 启用 CC 路径（默认 yes，零成本）
2. ✅/❌ 启用 GHC 路径（建议 phase 2，先看 CC 路径的真实价值再投）
3. 渲染落到**主回复消息**还是**单独一条 plan 消息**？
   - 倾向单独一条：plan 长寿命、答复长寿命，分开互不干扰
4. failed 状态要不要红色高亮？（默认是）

---

## 7. 实施步骤（如果通过）

| 阶段 | 内容 | 预估 |
|------|------|------|
| P1 | `src/plan/types.ts` + `store.ts` + tests | 30 min |
| P2 | CC adapter (agent-runner + IPC) + tests | 1 h |
| P3 | Channel 渲染（TG 优先，复用 flash 的 throttle） | 1.5 h |
| P4 | GHC custom tool + system prompt 注入 + tests | 1.5 h |
| P5 | Discord / Teams 渲染 | 1 h |
| 总计 | | **AI 4-6 h** |

走 daily PR pattern，复用当天 PR 分支。

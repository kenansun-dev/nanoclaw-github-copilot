# RBAC simplification: drop isMain, allowFrom = owner

**Status**: proposal
**Author**: Kenan VM Claw
**Reviewer**: Kenan Rpi5 Claw
**Owner directive**: kenansun, 2026-05-14 09:42 GMT+8
**Branch**: `chore/2026-05-12-v2-schema-proposal` (same daily PR as `2026-05-14-memory-flush.md`)
**Companion proposal**: `docs/proposals/2026-05-14-memory-flush.md`

---

## TL;DR

Owner directive: 简化 v2 RBAC。**`allowFrom` 的人 = owner**，不区分 admin。`config = source of truth`，每次 boot 全量覆盖 `user_roles`。同时**清掉 fork 残留 169 处 `isMain`**（src/，dist/ 是 build 产物随之消失），所有 IPC 特权检查改 `isOwner(senderUserId)`。

Admin role 保留 schema enum（`UserRoleKind = 'owner' | 'admin'`），但 fork 代码不产 admin 行 / 不读 admin row — 等到我们真要做 approval 流时再启用。

---

## 1. Problem (kenan 2026-05-14 拷问 cycle)

现状 fork v2 模型有三层概念叠在一起，用户配 owner 要看代码才知道：

1. **`commands.ownerAllowFrom`** — 真正给 owner role 的 config key（`v2-reconcile.ts:118`），但**没有任何文档 / CLI / TUI 入口**告诉用户存在
2. **`accounts.<k>.allowFrom`** — 入站白名单，只写 `users` 表 + `agent_group_members`，**不**给 role
3. **`chats[].isMain: true`** — v1 老路径，`v2-migrate-chats.ts:251` 自动转成 `commands.ownerAllowFrom` + bootstrap owner row。fork 169 处代码还在读 isMain 做 IPC / scheduler / container 特权判定

后果：
- 用户配了 `accounts.default.allowFrom: ["8731..."]` 以为给了 owner，其实只是放进白名单
- IPC 跨 chat 操作仍看 `isMain`，跟 v2 RBAC 完全脱节
- 维护两套权限判定（v1 isMain + v2 RBAC），bug 面 ×2

证据（kenan VM v2.db 实测）：

```
user_roles:
  telegram:8731187021 → owner (global)   ← 来源：历史 isMain 迁移
  tui:default        → owner (global)   ← 来源：历史 isMain 迁移
agent_groups: main / Andy / folder=main / github-copilot
config: accounts.default.allowFrom=["8731187021"]   ← 单独不给 owner
config: 没有 commands.ownerAllowFrom               ← 真正 SoT 没人配
```

owner 身份**意外**靠"历史迁移残留"维持。如果用户清新装 + 只配 `allowFrom`，**没有 owner**。

---

## 2. Goal

1. 用户改 `nanoclaw.json` `allowFrom` → 重启即生效，DB owner row 自动跟随
2. config 是唯一 SoT，没有"孤儿 DB row"问题
3. 删干净 fork 169 处 isMain，IPC/scheduler/container 改 v2 RBAC 单源
4. 不影响在用 v2 schema 的 `agent_group_members` / `messaging_groups` 等其他表
5. 给未来加 admin role / approval 流留口（schema enum 保留，handler 留 stub）

Non-goal:
- **不**实现 admin role 的 config 入口（owner 同意：现在不需要）
- **不**实现 approval routing（依赖 admin，下一阶段做）
- **不**改 channel registration 流程（等 approval 一起做）

---

## 3. Design

### 3.1 Config schema (after)

```jsonc
{
  "channels": {
    "telegram": {
      "accounts": {
        "default": {
          "botToken": "${TELEGRAM_BOT_TOKEN}",
          "allowFrom": ["8731187021"],   // ← owner ids (DM 顶层 + 群顶层)
          "groups": {
            "-1001234": { "allowFrom": ["7777"] }  // ← 也是 owner（不区分 admin）
          }
        }
      }
    }
  }
  // commands.ownerAllowFrom: REMOVED
  // commands.adminAllowFrom: NEVER ADDED
  // chats[].isMain: REMOVED (chats[] 数组本身留着给 chat metadata/folder)
}
```

**Rule**: 任何位置出现在 `*.allowFrom` 的 user id（含 channelType 前缀后）都被视为 owner。

### 3.2 Reconcile (config → DB) — `v2-reconcile.ts` 改造

新算法（每次 boot 全量执行）：

```ts
// Step 1: collect all owner ids from config
const configOwners = new Set<string>();
for each channel.account a:
  for each id in a.allowFrom:           configOwners.add(`${channel}:${id}`)
  for each id in a.groupAllowFrom:      configOwners.add(`${channel}:${id}`)  // legacy alias
  for each group g in a.groups:
    for each id in g.allowFrom:         configOwners.add(`${channel}:${id}`)
// commands.ownerAllowFrom 仍读，但只为 backcompat warning（merge 进 set 后 log warn 一次）

// Step 2: insert users (INSERT OR IGNORE)
for uid in configOwners: ensureUser(uid, channelType)

// Step 3: sync user_roles where role='owner' AND agent_group_id IS NULL
const dbOwners = SELECT user_id FROM user_roles
                 WHERE role='owner' AND agent_group_id IS NULL
// DELETE owner rows not in config:
for uid in dbOwners - configOwners: DELETE FROM user_roles ...
// INSERT new owner rows:
for uid in configOwners - dbOwners: INSERT (uid, 'owner', NULL, 'reconcile', now)

// Step 4: admin rows — DO NOT TOUCH (forward compat; future config schema 可写入)
```

**SoT 性质**：`reconcile` 完成后，DB owner set = config owner set。CLI grant / 手插 SQL 添加的 owner 会被下次 boot **删除**。这是 owner 显式要的语义（"config 是 source of truth"）。

> Reviewer Q: 是否要给 CLI 一个 "session-only override" 让 dev 临时插 owner 不被覆盖？暂留 Q1 给 owner 决定。

### 3.3 isMain 拆除 — 169 处 grep 结果分类

文件 (fork `src/`)：

| 文件 | isMain 用途 | 替换策略 |
|---|---|---|
| `ipc.js`/`ipc.ts` | 跨 chat 发消息 / control / plugin install / register_group / refresh_groups / cron CRUD 别 chat | `isOwner(getUserIdForSourceGroup(sourceGroup))` |
| `task-scheduler.ts` | task CRUD 别 chat | 同上 |
| `host-runner.ts` | 选 main agent / 启动 main 容器 | 改读 `agent_groups.id='main'` |
| `container-runner.ts` | 容器 mount / env 注入 | 同上（main = 固定 agent_group） |
| `chat-manager.ts` | folder 命名（main vs unique-per-jid） | 改读 `messaging_groups` 表 metadata |
| `chat-reconcile.ts` | 同 chat-manager | 同上 |
| `session-routing.ts` | 路由 session 到 main vs detached | 改读 `messaging_group_agents` |
| `config-loader.ts` | 解析 `chats[].isMain` | 删（chats[] 仍读，但忽略 isMain 字段） |
| `slash-commands.ts` | `/chats` 显示 [main] 标记 | 改用 `agent_groups.id='main'` |
| `cli.ts`/`cli/pair.ts`/`cli/tui-direct.ts` | CLI 显示 + `chat set-main` 命令 | 改 CLI 操作 `messaging_group_agents` |
| `doctor.ts` | 健康检查 | 改 v2 schema 检查 |
| `db.ts`/`db/v2-migrate-chats.ts` | v1 schema 字段 + 迁移 | 迁移保留（一次性吃旧 config） |
| `mount-security.ts`/`channels/tui.ts`/`types-extensions.ts`/`modules/registered-groups-extensions/`/`index.ts` | 各种工具用 isMain 判分支 | case-by-case |

**关键替换函数（待加 `src/modules/permissions/access.ts` 或 fork-only ext）**：

```ts
/** Resolve the user id who "owns" the IPC source group (legacy concept).
 *  In v2 the source group is a folder name. We look up which messaging_group
 *  it maps to, then who has owner role on the agent_group it serves. */
export function isPrivilegedSourceGroup(sourceGroup: string): boolean {
  const mg = findMessagingGroupByFolder(sourceGroup);
  if (!mg) return false;
  // legacy IPC privilege ≈ "any owner reachable via this messaging_group"
  return getOwnersOfMessagingGroup(mg.id).length > 0;
}
```

### 3.4 Migration (one-shot)

`src/db/v2-migrate-chats.ts:251` 改两处：
1. 老路径 `chats[].isMain: true` → 不再写 `commands.ownerAllowFrom`，改成 push 进 `accounts.<channel>.allowFrom`（jid 拆出 platform id）
2. 老 `commands.ownerAllowFrom` 字段 → boot 时 merge 进 `accounts.*.allowFrom` + log warn `[deprecated] commands.ownerAllowFrom moved to accounts.*.allowFrom`

迁移幂等：跑两次结果一致。

### 3.5 IPC layer 长期方向（Phase 2，本 proposal 不实现）

上游已经删掉 IPC 整层（`migrate-from-v1/SKILL.md`: "no IPC"）。fork 跟进路线：
- Phase 1（本 proposal）：保留 IPC 文件通讯 + 把 isMain 检查替成 `isPrivilegedSourceGroup`
- Phase 2（独立 proposal）：删 IPC 整层，agent 容器直接通过 v2 entity model 调命令（沿上游路线）

---

## 4. Implementation plan

### Phase 1A: reconcile + config schema（本 PR 可做）
- `src/db/v2-reconcile.ts`: 改 step 3 为全量 sync（+5 LOC，−10 LOC）
- `src/v2-access.ts`: doc comment 更新（注释 only）
- `src/db/v2-migrate-chats.ts`: isMain → allowFrom 替换 + ownerAllowFrom backcompat（+30 LOC）
- 删 `commands.ownerAllowFrom` schema 类型（−2 LOC）
- Tests: `v2-reconcile.test.ts` 加 "DB owner row 不在 config 时被 DELETE" + "ownerAllowFrom backcompat" 共 +60 LOC
- **预估**: 1 commit, ~100 LOC, 2-3 测试

### Phase 1B: isMain 拆除（同 PR 或独立 commit）
- 加 `isPrivilegedSourceGroup` helper（+25 LOC）
- 169 处替换（grep + 手改，约 30 处需要逻辑改写，140 处直接替换）
- 删 `chats[].isMain` 解析（config-loader.ts）
- Tests: `ipc-auth.test.ts` 改 setup（不再注入 isMain，改注入 owner row）+ 各模块 tests 同步
- **预估**: 3-5 commits, ~400 LOC delta（−500 / +100 净缩），20 tests 改

### Phase 1C: docs
- 更新 README config example（删 isMain，演示 allowFrom = owner）
- 加 `docs/rbac.md` 说明"allowFrom = owner，admin 待启用"

### 风险表

| 风险 | 概率 | 缓解 |
|---|---|---|
| reconcile 误删生产 owner | 中 | 加 dry-run + boot log 列出"将删除的 owner"，首次 boot 不删只 warn（feature flag） |
| 169 处替换漏掉 case | 高 | grep `isMain` 必须 0 hit + lint rule 禁止再引入 |
| Phase 1B 一次性合太大 | 高 | 拆 3 个 commit：(a) helper + reconcile (b) IPC/scheduler/runner (c) chat-manager/CLI/doctor |
| 用户老 config 有 ownerAllowFrom 但没 isMain | 低 | backcompat warn + 自动 merge |
| 上游再变 schema | 中 | proposal 已对齐上游"role enum + user_roles 表"，schema 不动只动 fork-side reconcile + isMain 删除 |

---

## 5. Open questions for owner

1. **Reconcile DELETE 模式**：DB 有 owner row 但 config 没列 → 直接删？还是首次 boot 只 warn 不删（feature flag `reconcile.deleteUnknownOwners`）？
2. **`groupAllowFrom` 这个 legacy alias 留不留？**（`v2-access.ts:418` 还在读）建议合并到 `accounts.*.allowFrom`，删 alias。
3. **`chats[]` 数组本身**留不留？删 isMain 后 chats[] 还用于：(a) numeric id（CLI `chat set-main <id>`）(b) folder 解析。建议留数组但 deprecate `isMain` 字段。
4. **CLI 是否补 `ncl roles ls` / `ncl owners ls` 只读命令？**（不让用户改 DB，只让用户看 reconcile 结果）
5. **isMain 拆除是否分独立 PR？**owner 之前规则是"同一 daily PR"。本 proposal 假定全部进 `chore/2026-05-12-v2-schema-proposal`。如果太大想拆 follow-up PR，需要 owner 显式 OK（不破坏 PR-per-day rule）。

---

## 6. Coordination

- **Author**: VM Claw（本文档 + Phase 1A 实现）
- **Reviewer**: Rpi5 Claw（review + Phase 1B isMain grep audit）
- **Owner**: kenansun（决 5 个 Open Q + final approve）
- **同 PR 范围**: `chore/2026-05-12-v2-schema-proposal`
- **不另开 PR / 不另开分支**（遵守 MEMORY one-PR-per-day rule）
- **平行**: Rpi5 Claw 的 `2026-05-14-memory-flush.md` 与本 proposal 不冲突，可并行 review

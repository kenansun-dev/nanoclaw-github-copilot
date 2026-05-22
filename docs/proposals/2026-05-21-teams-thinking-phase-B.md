# Teams: native streaming thinking → answer phase (proposal B)

**Status**: 🟢 SHIP-AND-VERIFY (2026-05-22 13:50 GMT+8, owner override)

> 2026-05-22 update: kenan reviewed the spike requirement and elected
> **not to run the protocol spike**. Path forward: ship the design
> below + the reasoning-on extension (see new section at the bottom),
> verify hands-on in Teams. Spike script (`scripts/spike-teams-streaming.mjs`)
> stays in tree for future regression. If hands-on verification surfaces
> any of the three risks (short-chunk acceptance / group-channel reject /
> informative size), we revisit. Until then this is the green light to
> implement.
>
> Original phase B scope was flush-only (`reasoning=flash`); today's
> extension brings `reasoning=on` into the same state machine — one
> mechanism covers both modes (see "Extension: reasoning=on" section).

**Prior status**: ⛔ BLOCKED ON PROTOCOL SPIKE (2026-05-21 23:12 GMT+8)

> Post-push protocol research surfaced 3 MS Bot Framework streaming
> constraints that may invalidate the core mechanism (`commitAnswer`
> resetting `_latestText`). See "Protocol verification spike" section
> below. No implementation work until spike (1)+(2) clear. The design
> body below is preserved as the design candidate; any later edits
> must keep this banner until owner clears it.

**Original status**: draft, awaiting review
**Authors**: Rpi5 Claw (proposal), VM Claw (test matrix + open Q research)
**Discussion**: Discord #nanoclaw 2026-05-21 (Issues disabled on `kenansun-dev/nanoclaw-github-copilot`; this doc + the PR carry scope/discussion in place of a GH issue)

## Protocol verification spike (REQUIRED before any implementation)

VM Claw post-push doc research surfaced 3 protocol constraints that may invalidate the design below. Before any code change PR opens, a spike must verify:

1. **Short-chunk acceptance**: send `informative(thinking long text)` → send `streaming(short answer text, NOT containing thinking as prefix)` and observe whether the Teams server accepts the chunk or rejects it. If rejected → `commitAnswer()` reset semantics is impossible and B is dead in its current form.
2. **Group-channel rejection**: confirm streaming protocol returns `BadArgument: streaming api is not enabled` on a group channel even with proper `streaminfo` entities, so the dispatcher can guard with `chat_type === '1:1'` cleanly.
3. **Informative size**: confirm 1KB / 1000-char limit on informative `text` (already strongly implied by MS doc; spike is mostly a sanity check).

Spike artifact: `scripts/spike-teams-streaming.ts` (VM Claw, separate commit on this branch). Bot Framework REST direct POST, no SDK. Owner runs with real tenant + bot creds; paste raw responses to PR comment.

Decision tree:
- **Spike passes (1) AND (2)** → proceed with design below, address (3) by capping informative text
- **Spike fails (1)** → B dead. Fallback options up to owner:
  - B-alt-1: thinking-prefix concat (thinking + separator + answer all in `_latestText`, never resets)
  - B-alt-2: two streamMessage sessions in series (risk: kenan-rejected "reedit-no-newmsg" territory)
  - C revisit: Teams group channel can\'t do streaming thinking anyway by (2), so "no flash thinking on Teams" is partly forced — owner may accept C with this rationale


## Goal
Teams 上 flash `thinking` 可见，零 regression（不留空 bubble、不发新消息、不多 bubble、不闪烁）。利用 Teams streaming 协议在 **同一个 streamId** 里先渲染 thinking，answer 第一 chunk 到达时 **覆盖** 为 answer。

## Non-goals
- Teams 非 streaming channel 行为不变
- 其他 channel (Discord/TG/IRC/WhatsApp 等) 行为完全不变
- reasoning-mode (非 flash) thinking 渲染：out of scope
- Issue tracker integration: 出于 repo Issues disabled，本 doc 即 SoT

## Background
当前 dispatcher gate (`src/index.ts:545`):
```ts
streamThinking = thinkingMode === 'flash' && !!channel.editMessage && !channel.usesNativeStreaming
```
Teams `usesNativeStreaming=true` → flash thinking 被掐。直接放开 gate 会撞 kenan 之前踩的"消息乱 / 反复改一条不发新"问题（thinking edit 路径与 native streaming 路径并发，不同 messageId，Teams 对并发 `updateActivity` 容忍度差）。

之前讨论过两条 alternative：

- **方案 A (弃)**: 允许 dispatcher 用 `editMessage` 改 thinking message + 同时跑 native streaming answer。命中 kenan 历史踩坑（并发 updateActivity / 不稳定复现）。**不重蹈**。
- **方案 C (弃, 投机取巧)**: Teams 上显式保留 thinking gate，永不渲染 flash thinking。零代码改动但用户体验跟其他 channel 不对等，owner 不接受。

## Approach (B)

### 协议利用点
Teams streaming 协议（Bot Framework `streaminfo` entity）：
- 同一 stream 的所有 chunk 共用一个 `streamId`，client 渲染 `text` 字段为 "当前完整内容"
- 第一条 activity 必须是 `streamType: 'informative'` (bootstrap)，**整个 stream 只允许一次 informative**
- 后续 chunk 走 `streamType: 'streaming'`，覆盖前一次 `text`
- 收尾 activity 走 `streamType: 'final'`，把 typing 转 message

这意味着 thinking → answer 切换天然就是改 `_latestText` + 发 `streaming` chunk，Teams 客户端原生替换，不留空 bubble、不发新消息。

### TeamsStreamingSession 改造 (`src/channels/teams-streaming.ts`)

加一个单向状态机：

```
   ┌─────────────┐
   │  thinking   │  appendThinking() updates _latestText
   └──────┬──────┘
          │ commitAnswer()  (sync flip, irreversible)
          ▼
   ┌─────────────┐
   │   answer    │  chunk() updates _latestText (reset on entry)
   └──────┬──────┘
          │ end(finalText) | cancel()
          ▼
   ┌─────────────┐
   │   ended     │  any further append* / chunk -> drop+log.debug
   └─────────────┘
```

新增 public API:
- `appendThinking(cumulativeThinkingText: string): Promise<void>` — phase=thinking 时设 `_latestText` + schedule chunk；phase=answer/ended 时 drop+log.debug
- `commitAnswer(): void` — sync flip phase=answer，reset `_latestText=''`、`_lastSent=''`（next `chunk()` 会触发一次 `streaming` 覆盖 thinking 为 answer 起点）；phase!=thinking 时 no-op
- 现有 `chunk()` / `end()` / `cancel()` 行为不变；`chunk()` 内部不感知 phase

invariants:
1. `informative` activity 只发一次（bootstrap，由 `_bootstrapSent` 自然 coalesce；多次 `appendThinking` 在 bootstrap 之前到 → 都走 `_latestText` 覆盖 + 单次 informative 出去，不可能发两次 informative）
2. phase 单向：thinking → answer → ended；不可回退
3. `commitAnswer()` 之后 `appendThinking()` 必须 drop，**不能让 SDK trailing reasoning_delta 把 answer 退回 thinking**（这是 kenan 历史"消息乱"最像的 root cause 类）
4. `cancel()` 立即 → phase=ended，drain loop 自然退出；orphan informative bubble 由 dispatcher 的现有 dismiss 路径（`src/index.ts:687`）清掉

### Dispatcher 改造 (`src/index.ts`)

加 channel cap `supportsNativeThinking?: boolean` (Teams=true, 其他 channel 不设)。

gate 改为：
```ts
streamThinking = thinkingMode === 'flash' && (
  (!!channel.editMessage && !channel.usesNativeStreaming) ||  // 旧路径（TG 等）
  !!channel.supportsNativeThinking                            // 新路径（Teams）
);
```

当 `supportsNativeThinking=true`：
- `reasoning_delta` 路径不再走 `channel.sendMessage` / `editMessage(thinkingMsgId, ...)`，而是：
  - 第一次：`streamHandle = await channel.streamMessage(jid)`，然后 `streamHandle.appendThinking(text)`
  - 后续：`streamHandle.appendThinking(text)`
- 第一个 answer partial 到达时：`streamHandle.commitAnswer()`，然后照常 `streamHandle.chunk(answerText)`
- thinking 路径的 `thinkingMsgId` 这边永远不设（避免 dispatcher cleanup 时走 `editMessage` 删 thinking — Teams 是 streamHandle 自己管的）
- 现有 `flashEditCoalescer` 在此路径下 bypass

其他 channel（无 `supportsNativeThinking`）走老路径，零影响。

### StreamHandle interface 扩展 (`src/types-extensions.ts:142`)

```ts
export interface StreamHandle {
  chunk(cumulativeText: string): Promise<void>;
  end(finalText: string): Promise<string | void>;
  cancel(): Promise<void>;

  // New optional methods for native thinking support.
  // Channels without supportsNativeThinking won't have these called.
  appendThinking?(cumulativeThinkingText: string): Promise<void>;
  commitAnswer?(): void;
}
```

```ts
export interface Channel {
  // ...
  /**
   * Channel renders thinking → answer natively inside a single stream
   * (e.g. Teams Bot Framework streaming activities). When true, dispatcher
   * routes reasoning_delta into streamHandle.appendThinking() instead of
   * the legacy editMessage(thinkingMsgId, ...) path, and calls
   * streamHandle.commitAnswer() once before the first answer chunk()
   * to flip the stream from thinking → answer.
   *
   * Channels that set this MUST implement StreamHandle.appendThinking
   * and StreamHandle.commitAnswer.
   */
  supportsNativeThinking?: boolean;
}
```

## Test matrix (全部 pass 才 merge)

| #   | Case                                                  | Expected                                                                                                                                                                |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | thinking → answer → end happy path                    | 单 streamId、单 bubble、内容 thinking → answer → final，无新消息                                                                                                          |
| b   | thinking phase cancel                                 | informative 已发的 orphan bubble 通过现有 dismiss 路径清掉（index.ts:687）。Open Q1: Teams 是否接受 updateActivity 把 typing(streaming) 转成 message(final empty)              |
| c   | answer phase cancel                                   | 现有行为，regression check                                                                                                                                              |
| d   | thinking phase ContentStreamNotAllowed                | drop thinking，不降级 sendMessage；answer 走非 streaming final                                                                                                          |
| e   | thinking phase BadArgument: streaming api not enabled | 同 d                                                                                                                                                                    |
| f   | thinking chunk send 网络失败                          | abort stream，end() fallback 走单条非 streaming final                                                                                                                  |
| g   | thinking 还在 drain loop，answer 第一 chunk 到达      | `_latestText` 串行覆盖；`_bootstrapSent` 不被重置，验证                                                                                                                |
| h   | bootstrap 前多次 appendThinking                       | coalesce 到单次 informative（Teams 限制 1 informative per stream）— 由 `_bootstrapSent` 自然 coalesce，无新机制                                                         |
| i   | thinking 超 Teams activity size                       | informative 只载第一片，后续 streaming chunks 续上（Open Q3: 硬上限）                                                                                                   |
| j   | 极短第一 answer chunk (<10 字符) 覆盖长 thinking      | 客户端单次过渡，不闪烁                                                                                                                                                  |
| k   | thinking phase 时 end() 触发（没收到 answer chunk）   | finalText 非空 → `commitAnswer()` + 一次 `streaming` 覆盖 finalText → `final` endStream；finalText 空 → dismiss（复用现有路径）。**不发 thinking 当 final**（C-trap）  |
| l   | commitAnswer() 之后 trailing reasoning_delta          | 静默 drop（log.debug），不能覆盖 `_latestText`                                                                                                                          |
| m   | Discord/TG/IRC 等 flash thinking                      | 完全不动旧路径                                                                                                                                                          |

## Open questions

- **Q1**: Teams 是否接受 `updateActivity` 从 `typing(streaming)` 转 `message(final empty / 单空格)`？决定 case (b) 实现 — VM Claw 接读 MS doc + Bot Framework streaming spec 后补结论
- **Q2**: case (k) 语义 — 已在 matrix 内拍定（finalText 非空覆盖 / 空 dismiss）。如果 owner 想换语义在此提
- **Q3**: informative activity payload 硬 size limit — VM Claw 预判无明文硬限只有 Activity 整体 25KB 软限；待 confirm

## Deliverables

- [x] Proposal doc (this file)
- [ ] State machine diagram for `TeamsStreamingSession` phase transitions — 上面的 ASCII 已 cover，PR review 阶段视需要补 mermaid
- [ ] Open Q1 / Q3 结论补回本 doc（VM Claw）
- [ ] Implementation PR on a dedicated feature branch (不进 daily PR)
- [ ] e2e tests covering matrix a–m
- [ ] Manual repro on Teams Windows client (kenan signoff)

## Owners

- Proposal doc: Rpi5 Claw
- Test matrix maintenance: VM Claw
- Q1 / Q3 research: VM Claw
- Implementation: TBD after proposal review by owner

## Risks / rollback

- Risk: 状态机 bug 让 thinking phase 卡住不切 answer → answer 永不显示。Mitigation: dispatcher 在第一 answer partial 必发 `commitAnswer()`，且 `commitAnswer()` 自身 idempotent
- Risk: SDK trailing reasoning_delta 还是覆盖了 answer。Mitigation: `appendThinking` 在 phase!=thinking 时 drop+log.debug；testcase (l) 覆盖
- Risk: Teams 客户端某版本不接受 `text` 在 streaming chunk 间剧烈变化。Mitigation: 实测三平台（Windows/Mac/Web）；kenan signoff before merge
- Rollback: `supportsNativeThinking` 是 channel cap，关掉它即回到 gate 排除 Teams 的现状（零行为变化）。代码 revert 也可，因新路径全部在 `if (channel.supportsNativeThinking)` 之内

---

## Extension: `reasoning=on` (2026-05-22, VM Claw)

### Scope
kenan 2026-05-22 proposal 引入三态：`off` / `on` / `flash`。原 phase B 只 cover `flash`。本扩展把 `reasoning=on` 也接到 phase B 同款 `TeamsStreamingSession` 状态机上 — **一套机制 cover 两个 mode**，零新协议、零新状态、零新风险面。

### Behavior contract (`reasoning=on`)
用户体验：
- thinking 流式渲染在气泡顶部，作为 markdown 引用块 (italic)：`> _thinking 已出部分_`
- thinking 下方空一行，答案 stream 在下半段
- thinking 跟答案**永久共存**（不像 flash 那样答案出现就删 thinking）
- 整个 turn 全程**单条消息单个气泡**，原地刷新

### Mechanism
复用 phase B 的 `TeamsStreamingSession`，**不调用 `commitAnswer()`**。phase 保持在 `thinking`，但 dispatcher 用一个新的写入路径：

```
appendBoth(thinkingBuf, answerBuf) →
  this._latestText = thinkingBuf ? `> _${thinkingBuf}_\n\n${answerBuf}` : answerBuf
  schedule chunk
```

或者更轻一层：dispatcher 自己拼好 `cumulativeText = formatThinkingPrefix(thinking) + answer`，调现有 `streamHandle.chunk(cumulativeText)` 一次。**`appendThinking` / `commitAnswer` 在 reasoning=on 路径下根本不调** — `chunk()` 单方法就够。

采纳后者，理由：
- API surface 最小（不在 `StreamHandle` interface 加新方法）
- dispatcher 已经持有 thinkingBuf + answerBuf 两个累积字符串，拼接 trivial
- Rpi5 实现时只需一行 helper：`const text = thinkingBuf ? formatThinkingPrefix(thinkingBuf) + '\n\n' + answerBuf : answerBuf`

### Why this isn't a protocol risk on top of phase B
phase B 的 spike 担心的是 "chunk 文本剧烈变化（thinking 整段删掉变 answer）"。reasoning=on 路径下文本**单调追加** (thinking 段只增不删，answer 段只增不删)，跟 ② 现状 Telegram flash thinking 路径一样的 monotone-grow pattern，Teams 客户端没理由拒绝。

这条路径的风险**严格弱于** phase B flush 路径 — 如果 phase B flush 能 ship，reasoning=on 必然 ship 得了。

### Dispatcher gate (`src/index.ts:545`) updated
```ts
streamThinking = thinkingMode === 'flash' && (
  (!!channel.editMessage && !channel.usesNativeStreaming) ||  // legacy (TG)
  !!channel.supportsNativeThinking                            // phase B (Teams)
);
inlineThinking = thinkingMode === 'on' && (
  // existing prepend path for non-streaming channels
  ... ||
  !!channel.supportsNativeThinking                            // new (Teams)
);
```

`inlineThinking` + `supportsNativeThinking` 走新分支：
- 每个 `reasoning_delta`: 累积 thinkingBuf, 调 `streamHandle.chunk(formatThinkingPrefix(thinkingBuf) + '\n\n' + answerBuf)` (answerBuf 此刻为 '')
- 每个 `answer partial`: 累积 answerBuf, 调 `streamHandle.chunk(formatThinkingPrefix(thinkingBuf) + '\n\n' + answerBuf)`
- `end(finalAnswer)`: 调 `streamHandle.end(formatThinkingPrefix(thinkingBuf) + '\n\n' + finalAnswer)`

### Test matrix additions (extends a–m)

| #   | Case                                                                                              | Expected                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| n   | reasoning=on happy path: thinking → answer 全程拼接                                                | 单气泡，thinking 引用块在上+answer 在下，两段都流式增长，final 留两段                              |
| o   | reasoning=on thinking 为空（模型没出 reasoning）                                                  | 走纯 answer 路径，不渲染空引用块                                                                  |
| p   | reasoning=on answer 第一字到达时 thinking 还在 stream                                              | 下一个 chunk 文本 = `> _think 部分_\n\nanswer 部分`，两段在同一气泡里都继续增长                  |
| q   | reasoning=on 收到 trailing reasoning_delta（answer 已出）                                          | thinkingBuf 继续追加, 下一个 chunk 重发 `> _更长 think_\n\nanswer`（thinking 在上半段继续长）   |
| r   | reasoning=on cancel                                                                              | 复用 phase B cancel 路径（dispatcher dismiss 现有逻辑）                                          |
| s   | reasoning=on + 其他 channel (TG/Discord)                                                          | 走旧 prepend 路径，行为不变                                                                       |

### Implementation split (建议两 commit)
1. **commit 1** — phase B 原 scope: `appendThinking` + `commitAnswer` API + dispatcher flush 分支
2. **commit 2** — reasoning=on extension: dispatcher gate 加 `inlineThinking` 分支 + thinkingBuf+answerBuf 拼接 helper, 复用 `streamHandle.chunk()`

Review: VM Claw 重点看 dispatcher gate (`src/index.ts:545`), Rpi5 Claw 主推 implementation。

# Teams streaming bootstrap-reject: delivery guarantee + evidence

Status: DRAFT (Rpi5 + VM joint proposal, requested by kenan 2026-08-03)
Deployed HEAD at investigation: `c4bc8a5`

## 1. Problem (PROVEN from live log 2026-08-03)

kenan's interactive Teams DM reply evaporates: the agent runs, but the
reply never lands and no "typing" resolves into a message.

Live evidence (kenan's `ncl logs -f`, 2026-08-03, both `/health` ok):
```
10:56:25 WARN Teams streaming: chunk send failed ... err="Only start streaming and continue streaming types are allowed as a typing activity" isBootstrap=true streamType="informative" sequence=1 statusCode=400 body=undefined
10:56:31 WARN (same)
```
- `curl localhost:3978/health` AND `curl <tunnel>/health` both returned
  `{"status":"ok"}` → inbound + host are fine. This is **outbound**, not
  tunnel/inbound. (Corrects the 8/2 inbound hypothesis.)
- The reject is on the **bootstrap frame** (the first `informative`
  "start-streaming" typing activity), HTTP 400.
- After the reject there is **no** `coalesced-final fallback` /
  `degraded final send` line and **no plain message** reaches the user →
  the reply is dropped. #73's degrade-to-plain did not fire in the
  "first frame rejected" case.

## 2. Two independent defects (label certainty honestly)

**Defect A — delivery gap (✅ gap is real; TWO distinct terminal drop-paths)**
VM pinned one path, Rpi5 pinned another. They are NOT interchangeable —
a complete guarantee needs both closed. Both verified against `c4bc8a5`.

- **A-path-1 (VM): `end()` reached, every send fails, signal swallowed.**
  `TeamsStreamingSession.end()` on total failure (final-streamType reject
  → last-ditch plain `message` also rejected) only `log.error` then
  `return void` (teams-streaming.ts:417). Dispatcher
  (`index.ts:1016`) takes the `end()` return and **unconditionally** sets
  `outputSentToUser=true` + `turnFinalized=true` (index.ts:1048) even when
  nothing was delivered → answer dropped AND cursor not rolled back (retry
  won't resend). Existing test (`teams-streaming.test.ts:462`) only covers
  "last-ditch plain send SUCCEEDS", so this gap is untested.
- **A-path-2 (Rpi5): all-partial turn, `end(text)` never called.**
  `end(text)` is only invoked from the **non-partial** final branch
  (index.ts:1016). If the GHC turn emits only `partial:true` deltas and no
  distinct `assistant.message` final, line 1016 never runs → `end()` never
  runs → **VM's A-path-1 signal never fires.** The finally-guard
  (index.ts:1130) calls `cancel()` (not `end()`), which publishes nothing
  (`_explicitCancel`). The coalesce buffer only holds **non-partial**
  finals (`streamDiedCoalesced.push(text)` in the final branch; both
  terminal flushes guard `length > 0`), so it is empty → user gets
  nothing, silently.

**Which path did kenan hit? (leans A-path-2, not proven — no truncation
guarantee on the pasted tail):** his tail shows 2× `chunk send failed`
(bootstrap informative) and NONE of: `degraded final send failed` (338),
`final activity send failed` (408), or the coalesce-flush INFO line. If
`end()` had been reached with the wire cancelled and the plain-degrade
failed, line 338 WARN would be present. Its absence leans toward `end()`
never being reached = A-path-2. Cannot fully rule out a truncated tail.
**Consequence: VM's A-path-1 fix alone would likely NOT have saved this
turn.** Ship both.

**Defect B — why streaming is rejected at all (❓ UNPROVEN, 2 suspects)**
`body=undefined` in the log → the server's rejection detail was never
captured, so the *why* is unproven. Competing suspects, indistinguishable
from error-only logs:
- B-i: we stamp a **locally-minted streamId** on the bootstrap
  (informative) frame (`_stampStreamId` stamps every frame incl. the
  first; `_streamId = randomUUID()` at construction, intentional 5/29
  "bug 1" fix for continuation frames). Spec for the *start* frame may
  not want a client streamId → server rejects.
- B-ii: Teams service-side change (there is an upstream issue where the
  same 400 broke MS's own SDK), independent of our streamId.

We DO NOT bet B. The fix must not depend on B being resolved.

**Defect B — why streaming is rejected at all (❓ UNPROVEN, 2 suspects)**
`body=undefined` in the log → the server's rejection detail was never
captured, so the *why* is unproven. Competing suspects, indistinguishable
from error-only logs:
- B-i: we stamp a **locally-minted streamId** on the bootstrap
  (informative) frame (`_stampStreamId` stamps every frame incl. the
  first; `_streamId = randomUUID()` at construction, intentional 5/29
  "bug 1" fix for continuation frames). Spec for the *start* frame may
  not want a client streamId → server rejects.
- B-ii: Teams service-side change (there is an upstream issue where the
  same 400 broke MS's own SDK), independent of our streamId.

We DO NOT bet B. The fix must not depend on B being resolved.

## 3. Fix design (one PR, 3 layers)

### Layer A — Delivery guarantee (deterministic, root-cause-independent)
Both drop-paths must close; they are complementary, not either/or.
- **A1 (Rpi5) — terminal guard for the all-partial case (A-path-2).**
  At the dispatcher finally-guard, if the stream wire died
  (`streamHandle?.isCancelled?.()` true, or coalesce was armed) AND
  nothing reached the user (`!outputSentToUser`) AND we have accumulated
  answer text (`progressiveText`), publish it via `channel.sendMessage`
  once. Does not depend on `end()` being reached or a non-partial final.
  Gate on a `deliveredPlainFallback` flag so happy-path coalesce and this
  guard cannot double-send.
- **A2 (VM) — truthful delivery signal for the end()-reached case
  (A-path-1).** `end()` stops swallowing total failure: return a failure
  sentinel / throw when every send (final + last-ditch plain) failed.
  Dispatcher only sets `outputSentToUser=true` when a message id actually
  came back; on failure, do NOT mark finalized → roll back cursor so the
  retry re-sends. This makes both the drop AND the no-retry visible.
- A1+A2 test pins: (i) bootstrap 400 on an all-partial turn → exactly one
  plain message, zero dup, zero drop; (ii) `end()` reached + final reject
  + last-ditch plain also rejected → `outputSentToUser` stays false +
  cursor rolled back; (iii) healthy streaming turn → no second message.

### Layer B — Evidence (so the next occurrence is self-diagnosing)  [VM]
- **B1. Capture the reject body/subcode** (today `body=undefined`). #73
  reads `err.body`/`err.response.body` — wrong fields. VM located the real
  shape: BFA now goes through `@azure/core-rest-pipeline` → RestError, so
  the reject detail is on `err.statusCode` (HTTP), `err.code` (Bot
  Connector error code from `parsedBody.error.code`), `err.message`
  (server reason text, e.g. "Only start streaming..."), and
  `err.response.bodyAsText` / `err.response.parsedBody.error` (raw +
  structured). Log `statusCode + code + response.bodyAsText` on BOTH the
  bootstrap-reject and final-reject warns. Next occurrence → the server's
  raw reason is in the log → disambiguates suspect B-i vs B-ii.
- **B2. One INFO line per reply recording delivery outcome:**
  `Teams reply delivered via {streaming|plain-degraded|dropped}` so an
  error-only export still answers "did the answer land?" without live
  debug.
- **B3. Fix the `loglevel` no-op.** `ncl loglevel debug` does not actually
  raise runtime verbosity — kenan hit exactly this today (his tail stayed
  error-only, zero INFO, so the decisive `Teams webhook POST received`
  never showed). Root cause (VM corrected my first read — it is NOT
  envLock): `reloadFromConfigFile` already calls
  `setLogLevel(newLevel,{force:true})` which clears envLock, but that only
  mutates `currentLevel` in `log-extensions.ts`. The actual gate is
  `emit()` in `log.ts:59`, which compares against the **module-const
  `threshold`** frozen at startup from `process.env.LOG_LEVEL`
  (`log.ts:31`). `emit()` never reads `currentLevel`. So `getLogLevel()`
  returns debug, the CLI reports success, `Config reloaded level=debug`
  logs — but the real threshold is unchanged = silent no-op. (kenan's
  zero-INFO tail separately means his daemon started with env
  `LOG_LEVEL >= warn`.) Fix: make `emit()` read the mutable level (export
  a getter from log-extensions, or make `threshold` mutable and have
  `setLogLevel` update it) so force-unlock actually takes effect.
- **B4. Grep-completeness:** enumerate every path that reaches "wire
  rejected + nothing delivered" (bootstrap reject, mid-stream reject,
  thinking-phase reject, timeout, all-partial) and confirm each has a
  guaranteed plain-message terminal after A1+A2.

### Layer C — Streaming kill-switch (opt-in stopgap)  [Rpi5]
Config `channels.teams.streaming.enabled` (default true, per-account
override). false → `usesNativeStreaming=false` → every reply through plain
`sendMessage`, bypassing the streaming wire entirely. Immediate long-term
stopgap if this tenant persistently rejects streaming, and a clean
isolation lever for debugging.

## 4. Division of labor
- Rpi5: A1 (finally-guard terminal), C (kill-switch), doc integration.
- VM: A2 (end() signal + cursor rollback), B1–B4, review of A1/C.

## 5. Open question for kenan
- Is your tenant rejecting streaming **persistently** (→ ship C defaulted
  off = streaming disabled until B1 pins the cause) or **intermittently**
  (→ keep streaming on + rely on A1+A2 guarantee)? The live log shows
  repeated rejects across days, which leans persistent.

## 6. Test plan (to fill once fix lands)
- A1 regression: bootstrap 400 on all-partial turn → exactly one plain
  `message` with accumulated answer, no streaminfo entity, no duplicate;
  healthy streaming turn → guard does not add a second message.
- A2 regression: `end()` reached + final reject + last-ditch plain also
  rejected → `outputSentToUser` stays false + cursor rolled back for retry.
- C: `streaming.enabled=false` → streamMessage path not taken; reply via
  sendMessage; unaffected on TG/Discord.
- B2: delivery-outcome INFO asserted for streaming / degraded / dropped.

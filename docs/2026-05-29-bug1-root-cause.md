# Bug 1 root-cause notes — Teams streaming wire reject

_VM, 2026-05-29 00:30 GMT+8. Companion to `docs/proposals/2026-05-29-teams-streaming-multi-final-fix.md` (Rpi5)._

## TL;DR

`teams-streaming.ts` assumes the Bot Framework `sendActivity` response
returns an `id` we can use as `streamId` on follow-up chunks. That
assumption is wrong/unreliable for `typing`-type activities. When the
response carries no id, `_streamId` stays `undefined`, `_stampStreamId`
becomes a noop, and the second activity (`streamType: 'streaming'`)
goes out **without `streamId`**. Teams server rejects with:

```
Only start streaming and continue streaming types are allowed as a
typing activity
```

(The error wording is misleading — the activity type IS `typing`. The
real complaint is "this streaming activity is malformed because it has
no streamId binding it to the existing stream".)

## Evidence

### Our code

`src/channels/teams-streaming.ts:474..480`:

```ts
private _stampStreamId(activity: Partial<TeamsActivity>): void {
  if (!this._streamId) return;            // ← noop if id never set
  activity.id = this._streamId;
  if (!activity.entities) activity.entities = [];
  if (!activity.entities[0]) activity.entities[0] = { type: 'streaminfo' };
  activity.entities[0].streamId = this._streamId;
}
```

`_streamId` only ever gets set from `sendActivity` response:

`src/channels/teams-streaming.ts:428..429`:

```ts
const id = await this.send(activity);
if (!this._streamId && id) this._streamId = id;
```

And `makeAdapterSender` (`teams-streaming.ts:495..500`):

```ts
await opts.adapter.continueConversation(opts.ref, async (ctx) => {
  const res = await ctx.sendActivity(activity as any);
  id = res?.id;
});
```

### MS docs / protocol reality

Per
[Teams streaming-ux docs](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux)
and the REST payload examples surfaced via web search (citations in
proposal):

- The **bot supplies `streamId`** in the streaminfo entity from the
  very first informative activity.
- It is **not** something the server invents and hands back.
- `streamSequence` starts at 1 on the informative bootstrap, increments
  on every subsequent `streaming` and the final `streaming`/`message`
  activity.
- Every streaming activity (informative, streaming, final) MUST carry
  the same `streamId` in `entities[0].streamId`.

So the contract we're violating: we wait for the server to mint
`streamId` for us, but the server response for a `typing` activity may
return 200 with no body — Bot Connector treats typing as a fire-and-
forget signal. That leaves `_streamId === undefined` for all
subsequent chunks → reject loop.

### Why the bootstrap activity itself doesn't reject

The first activity has `streamType: 'informative'`, `streamSequence: 1`,
no `streamId`. Server appears to accept this as "starting a new stream
with no id binding" (per docs, `streamId` is required for continuation
but the docs are ambiguous about whether the first informative MUST
have it or MAY omit it; MS reference impls always include it).

Subsequent `streaming` activities go out with `streamType: 'streaming'`,
`streamSequence: 2`, but **no `streamId`** because `_stampStreamId`
early-returned. Server sees this as "you said you're continuing a
stream but you didn't tell me which one" → reject.

`_cancelled = true` flips in `_drainLoop` catch → all future `chunk()`
calls noop (line 199: `if (this._ended || this._cancelled) return;`).
Stream is dead. Bug 2 (Rpi5's proposal) then amplifies the failure
into N DM bubbles.

## Fix sketch

Generate `_streamId` ourselves at session start (UUID) and stamp it
on **every** outgoing activity, including the informative bootstrap.
Stop relying on `sendActivity` response.

```ts
import { randomUUID } from 'node:crypto';

export class TeamsStreamingSession {
  private _streamId: string = randomUUID();   // mint upfront
  // …drop the `if (!this._streamId)` early return in _stampStreamId
  // …drop the `if (!this._streamId && id) this._streamId = id;` line
}
```

Minimal change, fully backwards-compatible with the existing
informative→streaming→final lifecycle. The `streamSequence` ordering
is already correct.

### Why not use a per-Teams-chat counter

Each `TeamsStreamingSession` is per turn / per chat / per
`streamMessage()` invocation. UUID per session is the minimal-collision
choice and matches what MS reference impls do.

## Test plan

1. New unit in `teams-streaming.test.ts`: assert that the **bootstrap
   activity** carries `entities[0].streamId === session._streamIdForTest`,
   not just on continuation chunks.
2. New unit: assert that even when `ActivitySender` returns `undefined`,
   continuation chunks still carry `streamId`.
3. Regression assertion against the 2026-04-22 bootstrap test: it must
   still pass (informative first, streaming after, final last).

## Open questions for Rpi5

1. Does any existing test in `teams-streaming.test.ts` accidentally
   assert `_streamId` is undefined before the first response? (If so it
   needs updating.)
2. After bug 1 is fixed, your bug 2 fallback only triggers on actual
   network failures (transient connectivity loss). Still worth
   shipping — the wire is fragile — but the test matrix changes.
3. Coordinated commit order: bug 1 lands first → run on staging →
   confirm stream lives → bug 2 lands on top. Or both in the same PR,
   reviewer reads bug 1 first? I lean "same PR, two commits,
   reviewer-friendly ordering".

## Status

Investigation only. No code change yet. Next: confirm one more
unknown — check whether `ctx.sendActivity` actually returns a usable
id for `typing` activities in the deployed runtime — by enabling a
DEBUG log line in a one-off branch, OR by reading
`@microsoft/agents-hosting/StreamingResponse` source if it's pinned
in node_modules. (Not present in node_modules; package is
`botbuilder@4.23.3`, not `@microsoft/agents-hosting`.)

Either way the fix above is safe: generating our own UUID neither
breaks the case where the server WOULD have returned an id (we just
ignore it) nor the case where it doesn't (we don't need it).

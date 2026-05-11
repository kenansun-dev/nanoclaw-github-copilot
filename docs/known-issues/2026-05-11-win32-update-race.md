# Issue: win32 update race (b96ad9a, 2026-05-11)

## Symptom
`nanoclaw update --package <tgz>` fails with EBUSY rename on `container/agent-runner-ghc`.

## Root cause
1. `nanoclaw stop` -> `killAllAgentPids()` over 46 stale pids in `agent-pids.json`
2. win32 serial `taskkill /F /T` ~1s each -> ~46s wall
3. update.ts hard timeout `nanoclaw stop` at 15s -> ETIMEDOUT at pid ~16
4. update.ts proceeds to `npm install -g` but background taskkill keeps running
5. Grandchildren still hold file handles -> EBUSY

## Fix shipped (commits a6c076c + this)
1. Parallel `taskkill` on win32 (`Promise.all` over `execAsync`) - 46 pids ~= 1-2s wall (a6c076c)
2. Raise update.ts stop timeout 15s -> 120s as belt-and-braces (a6c076c)
3. update.ts polls `agent-pids.json` empty + main pid dead before npm install (this commit)

## Future hardening
- Prune `agent-pids.json` on every `recordAgentPid` / on startup (drop entries where `process.kill(pid, 0)` already throws). Stops 46-pid accumulation in the first place.
- Batch `tasklist /FI "PID eq X"` probe before taskkill (skip pids already dead).

## Workaround (now obsolete with fixes above; kept for archive)
PowerShell: kill node + nanoclaw, rm agent-pids.json, retry update.

/**
 * IPC (fork add-on) — module skeleton.
 *
 * Thin v2-shaped re-export of the fork's existing `src/ipc.ts`
 * (filesystem-watcher + JSON-message bridge between the host and
 * containers running the fork's GHC agent). Two distinct concerns:
 *
 *   1. processTaskIpc / sweepOrphanResponses — the legacy fork-only
 *      IPC channel for scheduled tasks, plugins, and one-shot
 *      requests written into `data/ipc/<group>/input/*.json`.
 *   2. handlePluginIpc — plugin protocol used by skills running
 *      inside the container to send file/react/group-snapshot
 *      requests back out to the host.
 *
 * Why a separate "fork add-on" module: v2 has no equivalent IPC
 * substrate — its messages_in / messages_out tables are the wire,
 * and modules talk to each other via direct imports. The fork's
 * filesystem IPC predates that design and is what GHC plugins +
 * scheduled tasks rely on. We keep it isolated here so B.5 router
 * merge can decide later whether to bridge IPC into messages_in or
 * keep the dual path for plugin compatibility.
 *
 * Wiring plan:
 *   - C-step4 / B.5: fork v1 dispatcher in `src/index.ts` already
 *     calls `startIpcWatcher(deps)`. Once router merge lands, the
 *     deps shape (sendMessage / sendFile / reactToMessage) needs
 *     to be re-derived from v2 channel adapters — that's the only
 *     real change required.
 *
 * Until wire-up: importing this module is a no-op other than
 * re-export.
 */
import { handlePluginIpc, processTaskIpc, startIpcWatcher, sweepOrphanResponses, type IpcDeps } from '../../ipc.js';

export const ipcFork = {
  startIpcWatcher,
  processTaskIpc,
  sweepOrphanResponses,
  handlePluginIpc,
};

export type { IpcDeps };

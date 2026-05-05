/**
 * Workspace directory name — single source of truth.
 *
 * Production value (post v2 mergeback, 2026-05-05): `.nanoclaw`. v2 ships as
 * the default; users see one workspace dir at `~/.nanoclaw/` regardless of
 * v1/v2 history. v1 → v2 schema upgrade is handled in-place by
 * `nanoclaw update`'s migration step (see `src/cli/update.ts`).
 *
 * History: v2-merge staging used `.nanoclaw-v2` to physically isolate from v1
 * prod data while we baked the rewrite. That isolation is no longer needed
 * once update can detect + migrate v1 schema in place.
 *
 * NOT exposed via env var on purpose — kenan asked for code-constant config
 * only, to keep deploys impossible to misroute via stray env settings.
 *
 * Any module that needs to compute a `~/.nanoclaw*` path MUST import this
 * constant (or use `workspacePath()` from `./workspace`) instead of
 * hardcoding the literal '.nanoclaw' string. The startup guard in
 * `./workspace.ts` asserts the resolved path's basename matches
 * WORKSPACE_DIR_NAME and aborts otherwise.
 */
export const WORKSPACE_DIR_NAME = '.nanoclaw';

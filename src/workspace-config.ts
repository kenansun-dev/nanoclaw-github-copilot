/**
 * Workspace directory name — single source of truth.
 *
 * v2-merge branch: '.nanoclaw-v2' (physically isolated from v1 prod data).
 * Merge-to-main: revert this constant to '.nanoclaw' before shipping v2 as default.
 *
 * NOT exposed via env var on purpose — kenan asked for code-constant config only,
 * to keep v2 staging deploys impossible to misroute via stray env settings.
 *
 * Any module that needs to compute a `~/.nanoclaw*` path MUST import this constant
 * (or use `workspacePath()` from `./workspace`) instead of hardcoding the literal
 * '.nanoclaw' string. The startup guard in `./workspace.ts` asserts the resolved
 * path's basename matches WORKSPACE_DIR_NAME and aborts otherwise.
 */
export const WORKSPACE_DIR_NAME = '.nanoclaw-v2';

/**
 * Legacy workspace dir name (v1 prod data). Used ONLY by:
 *   - first-run bootstrap to seed v2 from v1
 *   - startup guard error messages
 * Do NOT use this for any read/write path resolution.
 */
export const LEGACY_WORKSPACE_DIR_NAME = '.nanoclaw';

/**
 * Workspace directory name — single source of truth.
 *
 * Default: `.nanoclaw` (v1 + v2 share the same prod path; v2 schema is
 * back-compat with v1 today, so an in-place upgrade reads the existing
 * data without conversion).
 *
 * Dev / staging override: set `NANOCLAW_WORKSPACE_DIR=.nanoclaw-staging`
 * (basename only, lives under $HOME) to physically isolate a staging
 * deploy from prod data. Existing `NANOCLAW_WORKSPACE=/abs/path` still
 * wins over both — see `./workspace.ts` resolution priority.
 *
 * History: v2-merge originally hard-coded `.nanoclaw-v2` as a staging
 * guard while the schema was unverified. Real-user upgrade is "no-seam"
 * (data + .env + cron continue at the same path), so the constant is
 * back to `.nanoclaw` and the env var carries the dev opt-out.
 */
export const WORKSPACE_DIR_NAME =
  process.env.NANOCLAW_WORKSPACE_DIR && process.env.NANOCLAW_WORKSPACE_DIR.trim() !== ''
    ? process.env.NANOCLAW_WORKSPACE_DIR.trim()
    : '.nanoclaw';

/**
 * Legacy constant kept to avoid breaking any importers that still
 * reference it (e.g. test fixtures). Always equals `.nanoclaw`.
 */
export const LEGACY_WORKSPACE_DIR_NAME = '.nanoclaw';

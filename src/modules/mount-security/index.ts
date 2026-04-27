/**
 * Mount Security (v2 module slot) — re-export of fork's `src/mount-security.ts`.
 *
 * History: v2-merge originally lifted a slimmer copy of mount-security
 * into this module path (~95% match, types inlined, no `nonMainReadOnly`
 * boolean validation). Fork retained the canonical implementation in
 * `src/mount-security.ts` with stricter checks and `nonMainReadOnly`
 * support.
 *
 * Decision (rpi5 + VM, 2026-04-28 02:24 GMT+8): keep the fork
 * implementation as the source of truth and turn this v2 module path
 * into a thin re-export. Reasoning:
 *   1. Fork has stricter validation (`nonMainReadOnly` boolean check) —
 *      removing would be a behavioural regression.
 *   2. Two existing callers (`src/container-runner.ts`,
 *      `src/mount-security.test.ts`) keep working unchanged.
 *   3. Future B.5 / C-step4 callers can import from this stable v2
 *      module path (`from 'src/modules/mount-security'`).
 *   4. Naming consistency: `xxx-fork/` is reserved for fork add-ons that
 *      don't conflict with a v2 module slot. mount-security IS the v2
 *      slot, so we keep the bare name and re-export inside.
 *
 * Types come from fork's `src/types.ts` (canonical shape, includes
 * `nonMainReadOnly` field on `MountAllowlist`).
 */
export {
  loadMountAllowlist,
  validateMount,
  validateAdditionalMounts,
  generateAllowlistTemplate,
  type MountValidationResult,
} from '../../mount-security.js';

export type {
  AdditionalMount,
  AllowedRoot,
  MountAllowlist,
} from '../../types.js';

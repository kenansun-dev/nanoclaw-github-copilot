import { describe, expect, it } from 'vitest';

import {
  generateAllowlistTemplate,
  loadMountAllowlist,
  validateAdditionalMounts,
  validateMount,
  type AdditionalMount,
  type AllowedRoot,
  type MountAllowlist,
  type MountValidationResult,
} from './index.js';

describe('mount-security v2 module re-export', () => {
  it('re-exports the four runtime helpers', () => {
    expect(typeof loadMountAllowlist).toBe('function');
    expect(typeof validateMount).toBe('function');
    expect(typeof validateAdditionalMounts).toBe('function');
    expect(typeof generateAllowlistTemplate).toBe('function');
  });

  it('re-exports the canonical fork types (MountAllowlist with nonMainReadOnly)', () => {
    // Type-level assertion via runtime usage. nonMainReadOnly comes from
    // fork's src/types.ts MountAllowlist shape — the v2 inlined version
    // we replaced did not have it. If we accidentally pointed back at the
    // old inlined types this object would not type-check.
    const allowlist: MountAllowlist = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    const root: AllowedRoot = {
      path: '/tmp',
      allowReadWrite: false,
    };
    const mount: AdditionalMount = { hostPath: '/tmp/x' };
    const result: MountValidationResult = { allowed: false, reason: 'test' };
    expect(allowlist.nonMainReadOnly).toBe(true);
    expect(root.path).toBe('/tmp');
    expect(mount.hostPath).toBe('/tmp/x');
    expect(result.allowed).toBe(false);
  });

  it('generateAllowlistTemplate returns a parseable JSON string', () => {
    const template = generateAllowlistTemplate();
    expect(typeof template).toBe('string');
    expect(() => JSON.parse(template)).not.toThrow();
  });
});

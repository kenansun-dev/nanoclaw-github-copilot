/**
 * South-edge AAD token validation (VM, follow-up to #3).
 *
 * Replaces the hardcoded `rejectAllSouthToken` bootstrap stub with a real,
 * CONFIG-DRIVEN validator. The owner's NCL presents an AAD token in the gRPC
 * call metadata (`authorization: Bearer <jwt>`); we:
 *
 *   1. verify the token (signature + issuer + expiry against the tenant's Entra
 *      JWKS) — `verifyToken` is injected so the verifier is testable and the
 *      crypto stays out of the allowlist logic, and
 *   2. gate the verified caller's identity (oid / appid / upn) against the
 *      config allowlist (NCL_RELAY_ALLOWLIST).
 *
 * Why config-driven, not a written-in `return null`: the allowlist already
 * exists in config but nothing consumed it — auth was a hardcoded deny. With a
 * real verifier + the allowlist gate, acceptance is decided entirely by config
 * (empty allowlist = deny-all, fail-closed), no code edit needed to authorize a
 * caller. (kenan 2026-06-27.)
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { Metadata } from '@grpc/grpc-js';
import type { SouthCaller } from './grpc-server.js';
import { logger } from './logger.js';

/** Claims we read off a verified south-edge AAD token. */
export interface SouthTokenClaims {
  /** AAD object id (oid) — the stable allowlist key. */
  oid?: string;
  /** App id (appid / azp) when the token is an app-only token. */
  appid?: string;
  /** UPN / preferred_username, for human-owner allowlist entries + audit. */
  upn?: string;
}

export interface SouthValidatorDeps {
  /** Allowed oid / appid / upn values (config.southEdgeAllowlist). */
  allowlist: string[];
  /**
   * Verify the raw JWT and return its claims, or null if the token is invalid
   * (bad signature / issuer / expired). Injected; default is the real Entra
   * verifier from makeAadTokenVerifier.
   */
  verifyToken: (jwt: string) => Promise<SouthTokenClaims | null>;
}

function bearerFromMetadata(md: Metadata): string | null {
  const raw = md.get('authorization');
  if (!raw || raw.length === 0) return null;
  const v = typeof raw[0] === 'string' ? raw[0] : raw[0]?.toString();
  if (!v) return null;
  const m = /^Bearer\s+(.+)$/i.exec(v.trim());
  return m ? m[1].trim() : null;
}

/**
 * Build `validateSouthToken(md)` for the gRPC server. Returns the SouthCaller on
 * a verified + allowlisted token, else null (→ UNAUTHENTICATED). An empty
 * allowlist denies everyone (fail-closed).
 */
export function makeSouthTokenValidator(
  deps: SouthValidatorDeps,
): (md: Metadata) => Promise<SouthCaller | null> {
  const allow = new Set(deps.allowlist.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));

  return async function validateSouthToken(md: Metadata): Promise<SouthCaller | null> {
    const jwt = bearerFromMetadata(md);
    if (!jwt) {
      logger.warn('south auth: missing bearer token');
      return null;
    }

    let claims: SouthTokenClaims | null;
    try {
      claims = await deps.verifyToken(jwt);
    } catch (err) {
      logger.warn('south auth: token verify threw', { err: err instanceof Error ? err.message : String(err) });
      return null;
    }
    if (!claims) {
      logger.warn('south auth: token invalid');
      return null;
    }

    if (allow.size === 0) {
      logger.warn('south auth: allowlist empty — denying (fail-closed)');
      return null;
    }

    // Match any identity claim against the allowlist (case-insensitive).
    const candidates = [claims.oid, claims.appid, claims.upn].filter((s): s is string => !!s);
    const matched = candidates.find((c) => allow.has(c.toLowerCase()));
    if (!matched) {
      logger.warn('south auth: caller not on allowlist', { oid: claims.oid, appid: claims.appid, upn: claims.upn });
      return null;
    }

    return {
      objectId: claims.oid ?? matched,
      principal: claims.upn ?? claims.appid ?? matched,
    };
  };
}

// ─── Real Entra JWKS verifier (default; injected so the gate is unit-testable) ─

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
}

function b64urlJson(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

export interface AadVerifierDeps {
  /** Tenant id (config.tenantId). Issuer is checked against this tenant. */
  tenantId: string | undefined;
  /** Optional expected audience (the relay's south API appId). Skipped if unset. */
  audience?: string;
  /** Fetch the tenant JWKS; injectable for tests. Cached between calls. */
  fetchJwks?: (tenantId: string) => Promise<Jwk[]>;
  /** Clock, ms; injectable for tests. */
  now?: () => number;
}

async function realFetchJwks(tenantId: string): Promise<Jwk[]> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const json = (await res.json()) as { keys?: Jwk[] };
  return json.keys ?? [];
}

/**
 * Default verifier: RS256 signature against the tenant JWKS + issuer + expiry
 * (+ optional audience). Self-contained (node:crypto), no JWT dep. Returns the
 * claims on success, null on any validation failure.
 */
export function makeAadTokenVerifier(deps: AadVerifierDeps): (jwt: string) => Promise<SouthTokenClaims | null> {
  const fetchJwks = deps.fetchJwks ?? realFetchJwks;
  const now = deps.now ?? (() => Date.now());
  let jwksCache: { keys: Jwk[]; fetchedMs: number } | null = null;
  const JWKS_TTL_MS = 60 * 60 * 1000;

  async function keys(tenantId: string): Promise<Jwk[]> {
    if (jwksCache && now() - jwksCache.fetchedMs < JWKS_TTL_MS) return jwksCache.keys;
    const fresh = await fetchJwks(tenantId);
    jwksCache = { keys: fresh, fetchedMs: now() };
    return fresh;
  }

  return async function verifyToken(jwt: string): Promise<SouthTokenClaims | null> {
    if (!deps.tenantId) return null; // can't verify issuer/JWKS without a tenant
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    let header: { kid?: string; alg?: string };
    let payload: Record<string, unknown>;
    try {
      header = b64urlJson(headerB64) as { kid?: string; alg?: string };
      payload = b64urlJson(payloadB64);
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || !header.kid) return null;

    const jwk = (await keys(deps.tenantId)).find((k) => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return null;

    // Verify signature over `header.payload` using the JWK public key.
    let valid = false;
    try {
      const pub = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      valid = cryptoVerify(
        'RSA-SHA256',
        Buffer.from(`${headerB64}.${payloadB64}`),
        pub,
        Buffer.from(sigB64, 'base64url'),
      );
    } catch {
      return null;
    }
    if (!valid) return null;

    // Issuer must be this tenant's Entra v2 issuer.
    const iss = typeof payload.iss === 'string' ? payload.iss : '';
    const expectedIss = `https://login.microsoftonline.com/${deps.tenantId}/v2.0`;
    const altIss = `https://sts.windows.net/${deps.tenantId}/`;
    if (iss !== expectedIss && iss !== altIss) return null;

    // Expiry (with no skew tolerance; tokens are minted fresh per call).
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    if (exp * 1000 <= now()) return null;

    // Optional audience pin.
    if (deps.audience) {
      const aud = payload.aud;
      const audOk = Array.isArray(aud) ? aud.includes(deps.audience) : aud === deps.audience;
      if (!audOk) return null;
    }

    return {
      oid: typeof payload.oid === 'string' ? payload.oid : undefined,
      appid:
        typeof payload.appid === 'string'
          ? payload.appid
          : typeof payload.azp === 'string'
            ? payload.azp
            : undefined,
      upn:
        typeof payload.upn === 'string'
          ? payload.upn
          : typeof payload.preferred_username === 'string'
            ? payload.preferred_username
            : undefined,
    };
  };
}

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { Metadata } from '@grpc/grpc-js';
import {
  makeSouthTokenValidator,
  makeAadTokenVerifier,
  type SouthTokenClaims,
} from './south-auth.js';

function md(auth?: string): Metadata {
  const m = new Metadata();
  if (auth) m.set('authorization', auth);
  return m;
}

describe('south-auth: validator (allowlist gate)', () => {
  const okVerify = (claims: SouthTokenClaims) => async () => claims;

  it('accepts a verified caller whose oid is on the allowlist', async () => {
    const validate = makeSouthTokenValidator({
      allowlist: ['OID-OWNER'],
      verifyToken: okVerify({ oid: 'oid-owner', upn: 'owner@t' }),
    });
    const caller = await validate(md('Bearer xyz'));
    expect(caller).toEqual({ objectId: 'oid-owner', principal: 'owner@t' });
  });

  it('matches appid or upn too (case-insensitive)', async () => {
    const validate = makeSouthTokenValidator({
      allowlist: ['owner@T'],
      verifyToken: okVerify({ appid: 'app-1', upn: 'owner@t' }),
    });
    expect(await validate(md('Bearer x'))).toMatchObject({ principal: 'owner@t' });
  });

  it('rejects a verified caller not on the allowlist', async () => {
    const validate = makeSouthTokenValidator({
      allowlist: ['someone-else'],
      verifyToken: okVerify({ oid: 'oid-owner' }),
    });
    expect(await validate(md('Bearer x'))).toBeNull();
  });

  it('denies everyone when allowlist is empty (fail-closed)', async () => {
    const validate = makeSouthTokenValidator({
      allowlist: [],
      verifyToken: okVerify({ oid: 'anything' }),
    });
    expect(await validate(md('Bearer x'))).toBeNull();
  });

  it('rejects missing bearer / invalid token / verifier throw', async () => {
    const base = { allowlist: ['oid-owner'] };
    expect(await makeSouthTokenValidator({ ...base, verifyToken: async () => null })(md())).toBeNull();
    expect(await makeSouthTokenValidator({ ...base, verifyToken: async () => null })(md('Bearer x'))).toBeNull();
    expect(
      await makeSouthTokenValidator({
        ...base,
        verifyToken: async () => {
          throw new Error('jwks down');
        },
      })(md('Bearer x')),
    ).toBeNull();
  });
});

describe('south-auth: AAD JWKS verifier', () => {
  const tenant = 'tenant-guid';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };

  function signJwt(payload: Record<string, unknown>, kid = 'kid1', alg = 'RS256'): string {
    const header = { alg, kid, typ: 'JWT' };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${h}.${p}`);
    const sig = signer.sign(privateKey).toString('base64url');
    return `${h}.${p}.${sig}`;
  }

  const verifier = (now: number, audience?: string) =>
    makeAadTokenVerifier({
      tenantId: tenant,
      audience,
      now: () => now,
      fetchJwks: async () => [{ kid: 'kid1', kty: 'RSA', n: jwk.n, e: jwk.e }],
    });

  const validPayload = {
    iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
    exp: 2000,
    oid: 'oid-owner',
    appid: 'app-1',
    upn: 'owner@t',
  };

  it('verifies a well-formed token and extracts claims', async () => {
    const claims = await verifier(1000)(signJwt(validPayload));
    expect(claims).toMatchObject({ oid: 'oid-owner', appid: 'app-1', upn: 'owner@t' });
  });

  it('rejects an expired token', async () => {
    expect(await verifier(3_000_000)(signJwt(validPayload))).toBeNull();
  });

  it('rejects a wrong issuer', async () => {
    expect(await verifier(1000)(signJwt({ ...validPayload, iss: 'https://evil/' }))).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const t = signJwt(validPayload);
    const tampered = t.slice(0, -4) + 'AAAA';
    expect(await verifier(1000)(tampered)).toBeNull();
  });

  it('rejects a non-RS256 alg', async () => {
    expect(await verifier(1000)(signJwt(validPayload, 'kid1', 'HS256'))).toBeNull();
  });

  it('rejects an unknown kid', async () => {
    expect(await verifier(1000)(signJwt(validPayload, 'otherkid'))).toBeNull();
  });

  it('enforces audience when configured', async () => {
    const withAud = signJwt({ ...validPayload, aud: 'relay-api' });
    expect(await verifier(1000, 'relay-api')(withAud)).toMatchObject({ oid: 'oid-owner' });
    expect(await verifier(1000, 'other-api')(withAud)).toBeNull();
  });

  it('returns null without a tenant (cannot verify)', async () => {
    const v = makeAadTokenVerifier({ tenantId: undefined, fetchJwks: async () => [] });
    expect(await v(signJwt(validPayload))).toBeNull();
  });

  it('accepts the sts.windows.net v1 issuer form', async () => {
    const v1 = signJwt({ ...validPayload, iss: `https://sts.windows.net/${tenant}/` });
    expect(await verifier(1000)(v1)).toMatchObject({ oid: 'oid-owner' });
  });
});

import { describe, it, expect } from 'vitest';
import { makeFederationExchange, FederationConfigError } from './federation.js';

describe('federation: per-bot token exchange', () => {
  const tenant = 'tenant-guid';

  it('resolves appId from the shared botAppIds map and returns the connector token', async () => {
    let captured: URLSearchParams | null = null;
    const exchange = makeFederationExchange({
      botAppIds: new Map([['prod', 'appid-prod']]),
      tenantId: tenant,
      postForm: async (_url, form) => {
        captured = form;
        return { status: 200, json: { access_token: 'connector-token' } };
      },
    });
    const tok = await exchange('prod', 'imds-assertion');
    expect(tok).toBe('connector-token');
    expect(captured!.get('client_id')).toBe('appid-prod');
    expect(captured!.get('grant_type')).toBe('client_credentials');
    expect(captured!.get('client_assertion')).toBe('imds-assertion');
    expect(captured!.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(captured!.get('scope')).toBe('https://api.botframework.com/.default');
  });

  it('throws non-retryable FederationConfigError when the bot has no appId (app not found)', async () => {
    const exchange = makeFederationExchange({
      botAppIds: new Map(),
      tenantId: tenant,
      postForm: async () => ({ status: 200, json: { access_token: 'x' } }),
    });
    await expect(exchange('unknown', 'a')).rejects.toThrow(FederationConfigError);
    await expect(exchange('unknown', 'a')).rejects.toMatchObject({ retryable: false });
  });

  it('throws non-retryable when tenant is unset', async () => {
    const exchange = makeFederationExchange({
      botAppIds: new Map([['prod', 'appid']]),
      tenantId: undefined,
      postForm: async () => ({ status: 200, json: { access_token: 'x' } }),
    });
    await expect(exchange('prod', 'a')).rejects.toMatchObject({ retryable: false });
  });

  it('throws a plain (retryable) error on token endpoint failure', async () => {
    const exchange = makeFederationExchange({
      botAppIds: new Map([['prod', 'appid']]),
      tenantId: tenant,
      postForm: async () => ({ status: 400, json: { error: 'invalid_client', error_description: 'bad FIC' } }),
    });
    const err = await exchange('prod', 'a').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FederationConfigError);
    expect(err.message).toContain('bad FIC');
  });

  it('shares the same map instance used by inbound (single source of truth)', async () => {
    const shared = new Map([['prod', 'appid-prod']]);
    const exchange = makeFederationExchange({
      botAppIds: shared,
      tenantId: tenant,
      postForm: async (_u, form) => ({ status: 200, json: { access_token: `tok-${form.get('client_id')}` } }),
    });
    // Mutating the shared map (as onboarding would) is visible to the exchange.
    shared.set('staging', 'appid-staging');
    expect(await exchange('staging', 'a')).toBe('tok-appid-staging');
  });
});

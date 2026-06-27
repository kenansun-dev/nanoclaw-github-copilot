import { describe, it, expect } from 'vitest';
import { makeFederationExchange, FederationConfigError } from './federation.js';

describe('federation: per-bot token exchange (appId-as-routing-key)', () => {
  const tenant = 'tenant-guid';

  it('uses the incoming id AS the appId and returns the connector token', async () => {
    let captured: URLSearchParams | null = null;
    const exchange = makeFederationExchange({
      tenantId: tenant,
      postForm: async (_url, form) => {
        captured = form;
        return { status: 200, json: { access_token: 'connector-token' } };
      },
    });
    const tok = await exchange('appid-prod', 'imds-assertion');
    expect(tok).toBe('connector-token');
    expect(captured!.get('client_id')).toBe('appid-prod');
    expect(captured!.get('grant_type')).toBe('client_credentials');
    expect(captured!.get('client_assertion')).toBe('imds-assertion');
    expect(captured!.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(captured!.get('scope')).toBe('https://api.botframework.com/.default');
  });

  it('throws non-retryable FederationConfigError when the appId is empty', async () => {
    const exchange = makeFederationExchange({
      tenantId: tenant,
      postForm: async () => ({ status: 200, json: { access_token: '***' } }),
    });
    await expect(exchange('', 'a')).rejects.toThrow(FederationConfigError);
    await expect(exchange('', 'a')).rejects.toMatchObject({ retryable: false });
  });

  it('throws non-retryable when tenant is unset', async () => {
    const exchange = makeFederationExchange({
      tenantId: undefined,
      postForm: async () => ({ status: 200, json: { access_token: '***' } }),
    });
    await expect(exchange('appid', 'a')).rejects.toMatchObject({ retryable: false });
  });

  it('throws a plain (retryable) error on token endpoint failure', async () => {
    const exchange = makeFederationExchange({
      tenantId: tenant,
      postForm: async () => ({ status: 400, json: { error: 'invalid_client', error_description: 'bad FIC' } }),
    });
    const err = await exchange('appid', 'a').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FederationConfigError);
    expect(err.message).toContain('bad FIC');
  });

  it('targets the tenant token endpoint', async () => {
    let url = '';
    const exchange = makeFederationExchange({
      tenantId: tenant,
      postForm: async (u) => {
        url = u;
        return { status: 200, json: { access_token: 'x' } };
      },
    });
    await exchange('appid', 'a');
    expect(url).toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
  });
});

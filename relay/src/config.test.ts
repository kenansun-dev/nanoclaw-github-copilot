import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

describe('relay config', () => {
  it('uses Terraform-matching defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.webhookPort).toBe(3978);
    expect(c.grpcPort).toBe(8585);
    expect(c.southEdgeAllowlist).toEqual([]);
    expect(c.msiClientId).toBeUndefined();
    expect(c.tenantId).toBeUndefined();
  });

  it('reads the App Service injected env', () => {
    const c = loadConfig({
      WEBSITES_PORT: '8080',
      HTTP20_ONLY_PORT: '9000',
      NCL_RELAY_ALLOWLIST: 'aaa, bbb ,ccc',
      NCL_BOT_MSI_CLIENT_ID: 'msi-123',
      AZURE_TENANT_ID: 'tenant-xyz',
    });
    expect(c.webhookPort).toBe(8080);
    expect(c.grpcPort).toBe(9000);
    expect(c.southEdgeAllowlist).toEqual(['aaa', 'bbb', 'ccc']);
    expect(c.msiClientId).toBe('msi-123');
    expect(c.tenantId).toBe('tenant-xyz');
  });

  it('trims + drops empty allowlist entries', () => {
    expect(loadConfig({ NCL_RELAY_ALLOWLIST: ' , a ,, b , ' }).southEdgeAllowlist).toEqual(['a', 'b']);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ WEBSITES_PORT: 'notaport' })).toThrow(/WEBSITES_PORT/);
    expect(() => loadConfig({ HTTP20_ONLY_PORT: '0' })).toThrow(/HTTP20_ONLY_PORT/);
    expect(() => loadConfig({ WEBSITES_PORT: '70000' })).toThrow(/WEBSITES_PORT/);
  });
});

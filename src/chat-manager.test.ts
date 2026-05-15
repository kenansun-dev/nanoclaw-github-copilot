import { describe, it, expect } from 'vitest';
import { deriveGroupFolder } from './chat-manager.js';

describe('deriveGroupFolder', () => {
  it('returns a unique-per-jid main folder for isMain chats (no agent)', () => {
    const folder = deriveGroupFolder('tg:123', { isDefaultAgent: true });
    // Format: main-<channel>-<jidHash>; collapse-on-read maps it back to 'main'.
    expect(folder).toMatch(/^main-tg-[0-9a-f]{8}$/);
    expect(folder.length).toBeLessThanOrEqual(64);
  });

  it('returns a unique-per-jid main folder for isMain chats with agentId', () => {
    const folder = deriveGroupFolder('tg:123', {
      isDefaultAgent: true,
      agentId: 'my-agent',
    });
    expect(folder).toMatch(/^main-my-agent-tg-[0-9a-f]{8}$/);
    expect(folder.length).toBeLessThanOrEqual(64);
  });

  it('produces distinct folders for two isMain chats on different jids (same agent)', () => {
    const a = deriveGroupFolder('tg:111', { isDefaultAgent: true });
    const b = deriveGroupFolder('dc:222', { isDefaultAgent: true });
    expect(a).not.toBe(b);
  });

  it('produces deterministic folders for the same jid+agent', () => {
    const a = deriveGroupFolder('tg:123', { isDefaultAgent: true });
    const b = deriveGroupFolder('tg:123', { isDefaultAgent: true });
    expect(a).toBe(b);
  });

  it('returns sanitized JID when no agentId', () => {
    expect(deriveGroupFolder('tg:8731187021')).toBe('tg-8731187021');
    expect(deriveGroupFolder('tg:-4937542884')).toBe('tg--4937542884');
  });

  it('returns sanitized JID with no config', () => {
    expect(deriveGroupFolder('teams:abc-123')).toBe('teams-abc-123');
  });

  it('includes agentId prefix when assigned', () => {
    expect(deriveGroupFolder('teams:conv-123', { agentId: 'teams-host' })).toBe('teams-host--teams-conv-123');
  });

  it('isolates different agents in same conversation', () => {
    const conv = 'teams:a:1Rw3-S4Le_nHy4o';
    const folderA = deriveGroupFolder(conv, { agentId: 'agent-alpha' });
    const folderB = deriveGroupFolder(conv, { agentId: 'agent-beta' });
    expect(folderA).not.toBe(folderB);
    expect(folderA).toContain('agent-alpha');
    expect(folderB).toContain('agent-beta');
  });

  it('truncates to 64 chars when combined name is too long', () => {
    const longConvId = 'teams:' + 'x'.repeat(100);
    const folder = deriveGroupFolder(longConvId, { agentId: 'my-agent' });
    expect(folder.length).toBeLessThanOrEqual(64);
    expect(folder).toMatch(/^my-agent--/);
  });

  it('truncates base without agentId too', () => {
    const longJid = 'teams:' + 'a'.repeat(100);
    const folder = deriveGroupFolder(longJid);
    expect(folder.length).toBeLessThanOrEqual(64);
  });

  it('preserves at least 8 chars of base when truncating', () => {
    const longConvId = 'teams:' + 'y'.repeat(200);
    const folder = deriveGroupFolder(longConvId, {
      agentId: 'very-long-agent-name-that-takes-space',
    });
    expect(folder.length).toBeLessThanOrEqual(64);
    // Agent slug + '--' + at least 8 chars of base
    const parts = folder.split('--');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // The base part (everything after first '--')
    const basePart = parts.slice(1).join('--');
    expect(basePart.length).toBeGreaterThanOrEqual(8);
  });

  it('sanitizes special chars in agentId', () => {
    const folder = deriveGroupFolder('tg:123', {
      agentId: 'agent@special!chars',
    });
    expect(folder).toBe('agent-special-chars--tg-123');
  });

  it('folder starts with alphanumeric', () => {
    // agentId should start with a letter
    const folder = deriveGroupFolder('teams:conv', {
      agentId: 'teams-host',
    });
    expect(folder).toMatch(/^[A-Za-z0-9]/);
  });
});

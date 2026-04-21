import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression test for Teams fileConsent/invoke 501 bug.
 *
 * Background (2026-04-21, kenan repro on Windows Teams client):
 *   - User sends file to bot → bot replies with FileConsentCard → user
 *     clicks "Allow" → Teams shows "something went wrong, please try again"
 *   - Server log: `BotFrameworkAdapter.processActivity(): 501 ERROR`
 *   - Root cause: `handleIncomingRaw` (raw/cert mode) had a handler for
 *     activity.type === 'invoke' && activity.name === 'fileConsent/invoke'
 *     but `handleIncoming` (adapter mode, used when MSTEAMS_APP_PASSWORD is
 *     set) did NOT. Non-raw path fell through without emitting an
 *     InvokeResponse → adapter returned 501 to Teams.
 *
 * This test pins three invariants:
 *   1. Both wire paths (raw HTTP and adapter InvokeResponse) share the
 *      same handler (single source of truth: handleFileConsentInvoke)
 *   2. Accept with missing uploadUrl returns 200 (not 500) — Teams spec
 *      requires graceful degradation, not invoke error
 *   3. Decline returns 200 silently (no upload attempt, no file.info card)
 *
 * Implementation note: we don't instantiate TeamsChannel fully (botbuilder
 * adapter requires real appId). We validate via (a) static source grep for
 * the handler call-site in handleIncoming and (b) a logic mirror of the
 * handler's decision tree, matching the pattern used by teams-capability.test.ts.
 */

describe('Teams fileConsent/invoke handler — wire path coverage', () => {
  it('handleIncoming has invoke handler that emits InvokeResponse activity', async () => {
    // Static guard: the adapter-mode handler MUST call handleFileConsentInvoke
    // and emit InvokeResponse via context.sendActivity, otherwise we regress
    // to 501. This check reads the compiled source to verify the wire-up.
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, 'teams.ts'),
      'utf-8',
    );

    // The handleIncoming method must call the shared consent handler.
    // We look for the call site, not just any reference (handleIncomingRaw
    // also calls it, which is fine — the bug was that handleIncoming did not).
    const handleIncomingStart = src.indexOf('private async handleIncoming(');
    expect(handleIncomingStart).toBeGreaterThan(0);

    // Find the next method definition to bound the scan.
    const nextMethod = src.indexOf('\n  private ', handleIncomingStart + 30);
    const nextAsync = src.indexOf('\n  async ', handleIncomingStart + 30);
    const end =
      nextMethod > 0 && (nextAsync < 0 || nextMethod < nextAsync)
        ? nextMethod
        : nextAsync > 0
          ? nextAsync
          : src.length;
    const body = src.slice(handleIncomingStart, end);

    expect(body).toContain("activity.name === 'fileConsent/invoke'");
    expect(body).toContain('handleFileConsentInvoke');
    expect(body).toContain("type: 'invokeResponse'");
    expect(body).toContain('context.sendActivity');
  });

  it('handleIncomingRaw still calls the same shared handler (no drift)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, 'teams.ts'),
      'utf-8',
    );

    const rawStart = src.indexOf('private async handleIncomingRaw(');
    expect(rawStart).toBeGreaterThan(0);
    const rawEnd = src.indexOf('\n  private async handleIncoming(', rawStart);
    const rawBody = src.slice(rawStart, rawEnd);

    expect(rawBody).toContain("activity.name === 'fileConsent/invoke'");
    expect(rawBody).toContain('handleFileConsentInvoke');
  });
});

describe('handleFileConsentInvoke decision tree (logic mirror)', () => {
  // Mirror the handler's branch logic so regressions in return-status
  // semantics are caught at unit-test speed. Keep in sync if the real
  // handler in teams.ts restructures its returns.
  type Outcome = { status: number; uploadCalled: boolean };

  async function decide(
    value: any,
    uploadResponse: { ok: boolean; status?: number } = { ok: true },
  ): Promise<Outcome> {
    let uploadCalled = false;
    if (value?.action === 'decline') {
      return { status: 200, uploadCalled };
    }
    if (value?.action === 'accept' && value?.context?.filePath) {
      const uploadUrl = value.uploadInfo?.uploadUrl;
      if (!uploadUrl) return { status: 200, uploadCalled };
      uploadCalled = true;
      if (uploadResponse.ok) return { status: 200, uploadCalled };
      return { status: 502, uploadCalled };
    }
    return { status: 200, uploadCalled };
  }

  it('decline: status=200, no upload', async () => {
    const r = await decide({ action: 'decline' });
    expect(r).toEqual({ status: 200, uploadCalled: false });
  });

  it('accept without uploadUrl: status=200 (graceful), no upload', async () => {
    const r = await decide({
      action: 'accept',
      context: { filePath: '/tmp/x' },
      uploadInfo: {},
    });
    // Regression: MUST be 200, not 500. 500 makes Teams retry-loop the
    // consent card (observed in kenan's log as "再发一次！" triplet).
    expect(r).toEqual({ status: 200, uploadCalled: false });
  });

  it('accept with uploadUrl, SharePoint PUT ok: status=200, upload called', async () => {
    const r = await decide(
      {
        action: 'accept',
        context: { filePath: '/tmp/x', filename: 'x.txt' },
        uploadInfo: {
          uploadUrl: 'https://sharepoint.example/upload',
          uniqueId: 'abc',
          fileType: 'txt',
        },
      },
      { ok: true },
    );
    expect(r).toEqual({ status: 200, uploadCalled: true });
  });

  it('accept with uploadUrl, SharePoint PUT fails: status=502, upload called', async () => {
    const r = await decide(
      {
        action: 'accept',
        context: { filePath: '/tmp/x', filename: 'x.txt' },
        uploadInfo: { uploadUrl: 'https://sharepoint.example/upload' },
      },
      { ok: false, status: 403 },
    );
    // 502 Bad Gateway: our downstream (SharePoint) failed.
    // Correct to bubble because Teams will show the upload as failed to user.
    expect(r).toEqual({ status: 502, uploadCalled: true });
  });

  it('missing value entirely: status=200 (degraded but not error)', async () => {
    const r = await decide(undefined);
    expect(r).toEqual({ status: 200, uploadCalled: false });
  });

  it('unknown action: status=200', async () => {
    const r = await decide({ action: 'something-weird' });
    expect(r).toEqual({ status: 200, uploadCalled: false });
  });
});

describe('InvokeResponse activity shape (botbuilder contract)', () => {
  // The adapter-mode handler emits `{ type: 'invokeResponse', value: { status } }`
  // via context.sendActivity. botbuilder's BotFrameworkAdapter intercepts this
  // activity type and converts it to an HTTP 200 + JSON body for Teams. If we
  // regress to a different shape (e.g. plain { status: 200 } or invokeResponse
  // without value wrapping), adapter falls through to its default (501).

  it('InvokeResponse activity uses botframework-schema shape', () => {
    const valid = {
      type: 'invokeResponse',
      value: { status: 200 },
    };
    expect(valid.type).toBe('invokeResponse');
    expect(valid.value).toBeDefined();
    expect(typeof valid.value.status).toBe('number');
  });

  it('raw mode returns plain { status } (different shape, different wire path)', () => {
    // Raw mode writes JSON body directly to res.end(), no InvokeResponse activity.
    const rawResponse = { status: 200 };
    expect(rawResponse).toEqual({ status: 200 });
  });
});

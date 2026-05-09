import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Regression test for Teams inbound file attachment handling.
 *
 * Background (2026-04-21, kenan repro on Windows Teams client):
 *   - User drags `repo-list.json` into DM with bot
 *   - Bot replies: "I can't see attachments, only text messages"
 *   - This is hallucinated \u2014 Teams actually did send activity.attachments[]
 *     with the file info, but the bot's handleIncoming silently ignored it
 *
 * Root cause: same split-brain pattern as the fileConsent/invoke 501 bug.
 *   - handleIncomingRaw   had attachment download + text-mutation logic
 *   - handleIncoming      did NOT \u2014 attachments dropped, activity often
 *                         filtered by the `!activity.text` gate afterward
 *
 * Fix: extracted to processIncomingAttachments(), called from both paths.
 *
 * This test pins:
 *   1. Both wire paths reference the shared processor (static grep)
 *   2. Processor runs BEFORE the text-required gate (ordering matters:
 *      text-less file drops must have activity.text synthesized so the
 *      gate doesn't drop them)
 *   3. All exit paths from the processor surface the attachment to
 *      activity.text somehow \u2014 download ok, download fail, error, or
 *      unregistered group \u2014 so the agent always sees that a file arrived
 *      (kills the "I can't see attachments" hallucination)
 */

function readTeamsSrc(): string {
  return fs.readFileSync(path.resolve(__dirname, 'teams.ts'), 'utf-8');
}

function sliceMethod(src: string, marker: string): string {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  // Bound by the next `private`/`async` method declaration at the 2-space
  // class indentation level.
  const candidates = [
    src.indexOf('\n  private ', start + marker.length),
    src.indexOf('\n  async ', start + marker.length),
  ].filter((i) => i > 0);
  const end = candidates.length ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
}

describe('Teams inbound attachment handling \u2014 wire path coverage', () => {
  it('handleIncoming processes attachments via shared processor', () => {
    const src = readTeamsSrc();
    const body = sliceMethod(src, 'private async handleIncoming(');

    // Must call the shared processor on inbound activities with attachments.
    expect(body).toContain('activity.attachments');
    expect(body).toContain('processIncomingAttachments');
  });

  it('handleIncomingRaw uses the same shared processor (no drift)', () => {
    const src = readTeamsSrc();
    const body = sliceMethod(src, 'private async handleIncomingRaw(');

    expect(body).toContain('activity.attachments');
    expect(body).toContain('processIncomingAttachments');
  });

  it('handleIncoming calls processor BEFORE the text-required gate', () => {
    // Ordering invariant: processIncomingAttachments mutates activity.text
    // (appending or setting a [Document: ...] note). The gate at
    //   if (activity.type !== 'message' || !activity.text) return;
    // MUST run AFTER the processor, otherwise text-less file drops get
    // filtered before we can synthesize the note \u2192 silent drop.
    const src = readTeamsSrc();
    const body = sliceMethod(src, 'private async handleIncoming(');

    const processorIdx = body.indexOf('processIncomingAttachments');
    const gateIdx = body.indexOf('!activity.text) return');

    expect(processorIdx).toBeGreaterThan(0);
    expect(gateIdx).toBeGreaterThan(0);
    expect(processorIdx).toBeLessThan(gateIdx);
  });
});

describe('processIncomingAttachments \u2014 surfaces file to agent on every path', () => {
  // The whole point of the fix is: the agent must always know a file arrived,
  // even if download failed. Otherwise we regress to silent-drop and the
  // "I can't see attachments" hallucination. This test pins the four exit
  // paths: success, http-fail, error, unregistered-group.

  let body: string;
  beforeEach(() => {
    body = sliceMethod(readTeamsSrc(), 'private async processIncomingAttachments(');
  });

  it('success path: appends [Document: ...] note with local path', () => {
    expect(body).toContain('Teams file downloaded');
    // The success note includes the saved path so the agent can read it.
    expect(body).toMatch(/\[Document: \$\{fileName\}\] \(saved to /);
  });

  it('http failure path: surfaces failure note to activity.text (NOT silent)', () => {
    // Historical bug: failure branch only appended when !activity.text,
    // so a file drop with companion text would silently lose the file info.
    // Fix: failure note always appended.
    expect(body).toContain('Teams file download failed');
    expect(body).toMatch(/\[Document: \$\{fileName\}\] \(download failed/);
    // Must handle both text-present and text-absent cases (no `if (!activity.text)`
    // guard that swallows the note when text IS present).
    const failSection = body.slice(body.indexOf('Teams file download failed'));
    expect(failSection).toMatch(/activity\.text \+=/);
  });

  it('exception path: surfaces error note to activity.text', () => {
    expect(body).toContain('Failed to download Teams file');
    expect(body).toMatch(/\[Document: \$\{fileName\}\] \(download error/);
    const errSection = body.slice(body.indexOf('Failed to download Teams file'));
    expect(errSection).toMatch(/activity\.text \+=/);
  });

  it('unregistered-group path: still surfaces attachment info', () => {
    // Even if the chat has no registered group folder, we must NOT drop
    // the attachment silently. Surface [Document: name] so the agent sees
    // that a file was sent, even without a local download.
    // Covers both `!activity.text` and text-present cases.
    expect(body).toMatch(/if \(!activity\.text\) \{[\s\S]*?activity\.text = `\[Document: \$\{fileName\}\]`;/);
    expect(body).toMatch(/\} else \{[\s\S]*?activity\.text \+= `\\n\[Document: \$\{fileName\}\]`;/);
  });

  it('skips adaptive-card and hero-card attachments (non-file)', () => {
    expect(body).toContain('application/vnd.microsoft.card.adaptive');
    expect(body).toContain('application/vnd.microsoft.card.hero');
    expect(body).toContain('Teams attachment skipped');
  });

  it('prefers pre-authed downloadUrl for Teams file.info attachments', () => {
    // Teams file.info attachments come with a pre-authenticated SharePoint
    // downloadUrl \u2014 must NOT attach a bearer (would get rejected).
    // Other contentUrls need the bot's credentials.
    expect(body).toContain("'application/vnd.microsoft.teams.file.download.info'");
    expect(body).toMatch(/isTeamsFileInfo[\s\S]*downloadUrl/);
    expect(body).toMatch(/if \(!isTeamsFileInfo\)[\s\S]*credentialsFactory/);
  });
});

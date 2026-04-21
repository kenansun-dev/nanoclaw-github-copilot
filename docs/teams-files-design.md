# Teams Files: Send & Receive — Design Note

**Author**: Kenan VM Claw, 2026-04-21
**Status**: DRAFT — pending kenan diagnostic results + Rpi5 review
**Pairs with**: PR #19 commits 3b82b57 (diagnostic logging) + ongoing implementation

## TL;DR

Per [official Microsoft docs](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4):

| Scope | Receive | Send |
|---|---|---|
| `personal` (DM) | Bot APIs (file.download.info attachments) | Bot APIs (FileConsentCard) |
| `groupchat` | Graph API (delegated, OneDrive) | Graph API (delegated, OneDrive) |
| `channel` | Graph API (delegated, SharePoint) | Graph API (delegated, SharePoint) |

**Bot APIs only work in `personal` context.** Group/channel files require Microsoft Graph with **delegated** OAuth (acting on behalf of a user). Application-only permissions work *only* for tenant data migration, not regular bot operation.

This is a hard constraint from Microsoft, not an implementation choice.

## Current state (src/channels/teams.ts as of 94e6fc1)

### Receive (line 481-580)
- Parses `activity.attachments`
- For `application/vnd.microsoft.teams.file.download.info`: uses `att.content.downloadUrl` (pre-auth SharePoint URL, no token)
- For everything else: uses `att.contentUrl` + bearer token from `credentialsFactory`
- Downloads to `groups/<folder>/uploads/<filename>`
- Inlines path into `activity.text` so the agent sees `[Document: foo.pdf] (saved to /path/to/uploads/foo.pdf)`

### Send DM (line 959-1029, sendFile)
- Detects 1:1 vs group via `conversationType`
- 1:1: sends `FileConsentCard` (correct flow per docs)
- Group/channel: just sends a text message saying "file is at <server-path>" — **no actual upload**

### Send DM consent flow (line 374-457, fileConsent/invoke handler)
- Receives invoke when user clicks Accept/Decline on the consent card
- On Accept: PUTs file bytes to `value.uploadInfo.uploadUrl` with `Content-Range`
- On success: replies with `FileInfoCard` so user can open the file
- On failure: returns 502, logs error

## Known/suspected gaps

### Gap 1: Receive — kenan reported "I can't find the repo-list.json"

Symptom from today: kenan sent a file in Teams DM, agent didn't see it.

**Three possible causes** (need diagnostic log to disambiguate):

1. `attachments` array is empty/missing in the Bot Framework activity
   - Webhook missing required claims, or Teams app manifest doesn't declare `supportsFiles: true`
   - **Diagnose via**: 3b82b57's `Teams message activity received` log → `attCount` field
2. `attachments` present but skipped by our filter (no `contentUrl` AND no `content.downloadUrl`, or unrecognized contentType)
   - **Diagnose via**: `Teams attachment skipped` log → `contentType`/`hasContentUrl`/`hasDownloadUrl` fields
3. Download attempted but failed (401 token, 404 expired URL, 5xx, network)
   - **Diagnose via**: `Teams file download failed` log → `status` field

Fix depends entirely on which one. **Do not refactor before kenan reproduces with new tarball + debug log.**

### Gap 2: Send group/channel — no real upload

Current code sends "📎 File ready: foo.pdf (saved to /server/path)" as plain text. Useless to the user.

**Required**: Microsoft Graph API flow:

1. **Acquire delegated token** with `Files.ReadWrite` (groupchat → user's OneDrive) or `Sites.ReadWrite.All` (channel → SharePoint site).
   - **This requires user OAuth consent**, not just bot app credentials.
   - Bot framework gives us app-only tokens; those work only for migration scenarios per docs.
2. **Upload file** to OneDrive/SharePoint via Graph:
   - Small files (<4MB): `PUT /me/drive/items/{parent-id}:/{filename}:/content`
   - Large files: create upload session, chunk-PUT
3. **Get the driveItem URL** from the upload response
4. **POST chatMessage** to `/chats/{chat-id}/messages` (group) or `/teams/{team-id}/channels/{channel-id}/messages` (channel) with `attachments` referencing the driveItem URL

### Gap 3: Send DM consent flow — untested

Code looks complete but nobody has validated it end-to-end:
- Does the consent card render?
- Does Accept actually deliver the upload URL?
- Does our PUT include the right headers?
- Does the FileInfoCard show up after?

Probably mostly works (it's been there a while) but could have edge cases.

## Proposed work plan

### Phase 1: Diagnose (BLOCKS everything else)
**Owner**: kenan
**Steps**:
1. Install tarball with `94e6fc1` (PR #19 head)
2. `nanoclaw loglevel debug`
3. In Teams DM: send a small file (e.g. test.txt) to the bot
4. Capture `nanoclaw logs | grep -E "Teams message activity|Teams attachment|Teams file"` output and post it
5. Also try in group chat / channel if possible

**Deliverable**: log paste in #nanoclaw → tells us which gap to attack first.

### Phase 2: Fix receive (depends on Phase 1)
**Owner**: Rpi5
- If gap 1.1 (no attachments): check Teams app manifest, supportsFiles, webhook claims
- If gap 1.2 (skipped): widen contentType acceptance, add fallback URL probing
- If gap 1.3 (download failed): fix auth (might need delegated token instead of app-only)

### Phase 3: Validate DM send (consent flow)
**Owner**: kenan tests, Rpi5 fixes if broken
- Bot replies to a DM with `sendFile` → verify FileConsentCard renders → click Accept → file delivered → FileInfoCard appears
- This is the "easy win" — already implemented, just unverified.

### Phase 4: Implement group/channel send via Graph
**Owner**: Rpi5 implementation, VM design + reviews
- **Pre-requisite decision**: how do we get a delegated token?
  - Option A: User OAuth flow on first use (bot DMs user with sign-in card → user signs in → bot stores refresh token per user)
  - Option B: Use bot's own user identity (app installed by an admin who consented; bot has its own service account)
  - Option C: Skip group/channel send entirely — only support DM file send + group/channel receive (where Teams provides pre-auth download URL anyway)
- **Recommendation**: **Option C for v1**, then revisit. Option A is a 200-LOC refactor with token storage + refresh logic; Option B requires customer ops involvement. Option C unblocks 80% of the use case (DM send works, group/channel receive works) at near-zero cost.

### Phase 5 (optional): Group/channel real send via Graph
Only if Phase 1 diagnostics show users actually want this and Option C feels too limited.

## Acceptance criteria

For each scope, end-to-end test:
- [ ] DM receive: kenan sends test.txt → agent's prompt contains `[Document: test.txt] (saved to ...)` AND file exists at the path
- [ ] DM send: agent calls sendFile → kenan sees consent card → Accept → file appears in chat
- [ ] Group receive: someone in a group chat shares a file → agent sees the inline path
- [ ] Group send (Phase 5 only): agent calls sendFile → file actually shows up in group chat (not the placeholder text)

## Open questions

1. **Does the Teams app manifest in our setup currently declare `supportsFiles: true`?** If not, that's gap 1.1's cause and the fix is one config line + re-publish.
2. **Is there any tenant-scoped policy blocking bot file attachments?** Some org policies block external app file sharing.
3. **For group send Phase 5: which OAuth identity?** Need user input from kenan on his preference (Option A/B/C).

## References

- [Microsoft: Bots to Send and Receive Files](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4)
- [Microsoft: Send chatMessage with file attachments](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-beta&tabs=http#example-4-file-attachments)
- [Microsoft: OneDrive REST API](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/)

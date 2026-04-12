# Authentication Design — nanoclaw-github-copilot

## Overview

nanoclaw-github-copilot uses GitHub Copilot (via `@github/copilot-sdk`) as its AI backend.
Authentication requires a GitHub OAuth token (`ghu_...`) which the SDK exchanges
for short-lived Copilot API tokens at runtime.

## Token Types

| Token | Format | Lifetime | Stored by | Used for |
|-------|--------|----------|-----------|----------|
| GitHub OAuth token | `ghu_...` | Long-lived (until revoked) | OpenClaw auth profile | Exchanging for Copilot API tokens |
| Copilot API token | opaque | Short-lived (~minutes) | SDK internally | Actual model API calls |

## Auth Source Priority

`resolveGithubToken()` in `agent-runner/src/index.ts` resolves tokens in this order:

1. **Environment variables** (highest priority)
   - `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`
   - Best for: CI, headless servers, Docker, explicit deployments

2. **OpenClaw auth profile**
   - Reads `~/.openclaw/agents/main/agent/auth-profiles.json`
   - Finds any `github-copilot` provider profile with a token
   - Best for: Machines already running OpenClaw (e.g., RPi5)
   - No extra login needed — reuses OpenClaw's existing device flow login

3. **CLI managed auth** (fallback)
   - `CopilotClient()` with no token → uses `useLoggedInUser` mode
   - Requires system keychain or `store_token_plaintext` config
   - Best for: Developer machines with desktop environments

## Security Considerations

### Current State (PoC)
- The `ghu_` token is read on the host and passed to `CopilotClient`
- The SDK internally exchanges it for a short-lived Copilot API token
- The `ghu_` token itself is NOT sent to model endpoints
- Auth profile file permissions: `600` (owner-only read/write)

### Trust Boundary Notes
- **Sandbox/container environments**: If agent-runner runs in a sandbox,
  the `ghu_` token crosses the trust boundary. For production, consider
  a host-side auth provider that only passes short-lived tokens into sandboxes.
- **Token refresh**: The Copilot SDK handles exchange internally.
  For a more robust solution, implement explicit refresh/cache like OpenClaw's
  `resolveCopilotApiToken()` pattern.

### Future Improvements
1. Host-side token exchange — sandbox only receives short-lived Copilot API tokens
2. Explicit refresh/cache layer (like OpenClaw's `resolveCopilotApiToken`)
3. Configurable auth method (`auth.method` in config file)
4. Self-contained device flow (for deployments without OpenClaw)

## How OpenClaw Does It (Reference)

OpenClaw's GHC provider (`@mariozechner/pi-ai`):
1. Implements device code flow itself (no dependency on Copilot CLI)
2. Saves `ghu_` token to `auth-profiles.json`
3. At runtime: exchanges `ghu_` → Copilot API token via `copilot_internal/v2/token`
4. Caches short-lived token with `expiresAt`
5. Auto-refreshes when expired

nanoclaw-github-copilot currently reuses step 2's output and delegates steps 3-5 to the SDK.

## Verified ✅

- OpenClaw auth profile → `CopilotClient({ githubToken })` → `isAuthenticated: true`
- Full E2E: auth → createSession → sendAndWait → response received
- Model: `gpt-4o-mini`, response: `"hello"` (4 output tokens)
- No keychain dependency, no manual token copy, no throttling

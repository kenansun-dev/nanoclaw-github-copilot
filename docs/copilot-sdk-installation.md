# Copilot SDK installation (1.0.13)

The host package (including the `/model` catalog) and both runners pin
`@github/copilot-sdk` to **1.0.13**. Node must satisfy
**`^20.19.0 || >=22.12.0`**.

## Runtime packaging

SDK 1.0.13 ships its runtime through optional
`@github/copilot-sdk-<platform>-<arch>` packages at **1.0.13**. Its published
`copilotCliVersion` / `dist/cliVersion.js` identify the bundled runtime as
**1.0.83**; `COPILOT_CLI_USE_NPM_PACKAGE` is false. The normal stdio transport
starts this bundle, not a separately installed `@github/copilot` package.
The runner's former direct CLI dependency and both CLI overrides are removed.

Each platform package contains:

- `prebuilds/<platform>-<arch>/copilot-runtime` (`copilot-runtime.exe` on Windows)
- `prebuilds/<platform>-<arch>/runtime.node`

There is no old CLI platform-package `/sdk` entry to resolve. Linux selects
`linux` for glibc or `linuxmusl` for musl using the Node process report; it
**does not try glibc then fall back to musl**. Both architectures (`x64`,
`arm64`) are locked for Linux glibc/musl, macOS, and Windows.

The separate interactive `copilot login` / doctor / installer workflows are
unchanged. They may still require the standalone CLI on PATH, but that is not
the SDK's bundled runtime dependency. An explicit `COPILOT_CLI_PATH` override
is outside the bundled-runtime installation guarantee.

## Application API compatibility

Both runners use typed `CopilotClientOptions`, pass the explicit token as
`gitHubToken`, and register non-empty plugin roots through
`builtinPluginDirectories`. The old untyped `githubToken` / `cliArgs`
properties are not read by the 1.0.13 constructor. The SDK keeps its default
bundled stdio transport; no experimental in-process transport is selected.
Plugin custom-agent loading and existing session behavior are retained; this
upgrade does not change authentication policy or claim to validate
authenticated inference.

## Installation verification

Keep optional dependencies and dependency installation scripts enabled.
In particular, Koffi's install hook selects/validates its native prebuild (or
builds it when necessary); `--ignore-scripts` is not an installation fix.
The lockfile-only regeneration step may skip scripts because it does not
install runnable dependencies.

After installation, the same read-only verifier works for all three packages:

```sh
node scripts/verify-copilot-install.mjs .
node scripts/verify-copilot-install.mjs container/agent-runner-ghc
node scripts/verify-copilot-install.mjs container/agent-runner
```

Postinstall checks the root as well as both runners. It rejects an npm install
failure, a non-exact/mismatched SDK version, a mismatched SDK-relative native
package, or missing/empty runtime artifacts. It never imports SDK/native code
or launches the CLI. Tests cover all eight platform layouts, SDK-relative
resolution (including pnpm-style symlinks), libc selection, stale packages,
damaged artifacts, and positive/negative postinstall outcomes.

A successful verifier proves the installed **version and file layout**, not
native ABI compatibility, authentication, model responses, or thinking output.
A separate credential-free lifecycle smoke can start the bundled stdio runtime
with `useLoggedInUser: false`, an isolated home/base directory, `mode: 'empty'`,
no available tools, and external networking blocked. Session creation and
stop without sending any prompt are not inference validation. Other operating
systems and architectures still require native CI/host smoke coverage.

## Plugin directory limit

Both runners resolve existing `NANOCLAW_PLUGIN_DIRS` entries to absolute paths
(relative to the runner's working directory) and deduplicate the resolved paths
in first-seen order. Empty and nonexistent entries are ignored as before.
The SDK's `plugins.builtin.set` accepts at most **64** roots and replaces the
complete set; repeated batches are **not** additive.

When there are more than 64 unique roots, only the **first 64** are registered
with the SDK. Startup logs a warning with the total count, skipped count and
all skipped paths. **Native plugin features beyond 64 are not loaded.** The
existing `loadPluginAgents` fallback still scans **all** normalized roots for
`agents/*.md` (including skipped roots), with its existing agent-name deduplication;
this does not restore other native plugin features.

Reduce `NANOCLAW_PLUGIN_DIRS` (PATH-separated: `:` on Unix, `;` on Windows), or
reduce the host's discovered plugin set, to 64 or fewer unique roots for full
native loading. Reordering puts the most important roots first but does not
remove the limit. Resolution is lexical (`path.resolve`), not symlink realpath
canonicalization.

Regression checks (no install or packaging lifecycle):

```sh
node node_modules/vitest/vitest.mjs run src/ghc-plugin-directories.test.ts src/ghc-sdk-options.test.ts
# Optional Linux native startup boundary probe, after compiling both runners:
node scripts/test-plugin-directories.mjs
```

The native probe requires `unshare --user --map-root-user --net`. It fails if
network isolation is unavailable; it never falls back to an online run. It uses
an empty allowlisted environment and temporary HOME, no credentials, no prompts
and no inference. Both runner SDKs must start with the bounded options for
64/65 input roots; the raw 65-root control must fail with the native limit error.

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

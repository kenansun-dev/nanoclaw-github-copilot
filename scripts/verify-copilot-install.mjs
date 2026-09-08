#!/usr/bin/env node

// Inspect files only: never import the SDK or launch a Copilot process here.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function findPackageJson(startPath, expectedName) {
  let current = path.dirname(startPath);
  while (true) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) {
      const packageJson = readJson(candidate);
      if (packageJson.name === expectedName) return { path: candidate, packageJson };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${expectedName}/package.json from ${startPath}`);
}

// SDK 1.0.13 runtimeArtifacts.js selects the host libc, NOT glibc-first fallback.
// Parameters let tests cover other platforms without importing native code.
export function runtimePlatform(platform = process.platform, arch = process.arch, musl) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported Copilot SDK architecture: ${arch}`);
  }
  if (platform === 'linux') {
    musl ??= process.report?.getReport()?.header?.glibcVersionRuntime === undefined;
    return `${musl ? 'linuxmusl' : 'linux'}-${arch}`;
  }
  if (platform === 'darwin' || platform === 'win32') return `${platform}-${arch}`;
  throw new Error(`Unsupported Copilot SDK platform: ${platform}-${arch}`);
}

function requireFile(filePath) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`Copilot SDK runtime file missing or empty: ${filePath}`);
  }
}

export function verifyCopilotInstall(directory, host = {}) {
  const packageDir = path.resolve(directory);
  const manifest = readJson(path.join(packageDir, 'package.json'));
  const expectedVersion = manifest.dependencies?.['@github/copilot-sdk'];
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? '')) {
    throw new Error(`${packageDir}: expected exact @github/copilot-sdk dependency`);
  }
  const packageRequire = createRequire(path.join(packageDir, 'package.json'));
  const sdk = findPackageJson(packageRequire.resolve('@github/copilot-sdk'), '@github/copilot-sdk');
  if (sdk.packageJson.version !== expectedVersion) {
    throw new Error(`SDK resolved to ${sdk.packageJson.version}; expected ${expectedVersion}`);
  }

  const platform = runtimePlatform(host.platform, host.arch, host.musl);
  const packageName = `@github/copilot-sdk-${platform}`;
  if (sdk.packageJson.optionalDependencies?.[packageName] !== expectedVersion) {
    throw new Error(`SDK must pin ${packageName} to ${expectedVersion}`);
  }
  // Match the ESM runtime's SDK-relative search, including pnpm's symlinked layout.
  // Platform packages have no /sdk export (or main); resolve their directory as
  // runtimeArtifacts.js does rather than importing an obsolete CLI /sdk entry.
  const runtimeRequire = createRequire(path.join(path.dirname(sdk.path), 'dist', 'runtimeArtifacts.js'));
  const platformDir = (runtimeRequire.resolve.paths(packageName) ?? [])
    .map((base) => path.join(base, ...packageName.split('/')))
    .find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (!platformDir) {
    throw new Error(`Could not resolve SDK-relative ${packageName}; reinstall with optional dependencies enabled`);
  }
  const platformPackage = readJson(path.join(platformDir, 'package.json'));
  if (platformPackage.name !== packageName || platformPackage.version !== expectedVersion) {
    throw new Error(`SDK-relative ${packageName} resolved to ${platformPackage.name}@${platformPackage.version}; expected ${expectedVersion}`);
  }
  const prebuildDir = path.join(platformDir, 'prebuilds', platform);
  const wrapper = path.join(prebuildDir, platform.startsWith('win32-') ? 'copilot-runtime.exe' : 'copilot-runtime');
  requireFile(wrapper);
  requireFile(path.join(prebuildDir, 'runtime.node'));
  return `Verified ${path.relative(process.cwd(), packageDir) || '.'}: SDK ${expectedVersion}, ${packageName} ${platformPackage.version}, runtime wrapper + runtime.node present`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(verifyCopilotInstall(process.argv[2] ?? '.'));
}

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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

function platformPackageNames() {
  const variants = process.platform === 'linux' ? ['linux', 'linuxmusl'] : [process.platform];
  return variants.map((variant) => `@github/copilot-${variant}-${process.arch}`);
}

const runnerDir = path.resolve(process.argv[2] ?? '.');
const runnerPackage = readJson(path.join(runnerDir, 'package.json'));
const expectedSdkVersion = runnerPackage.dependencies?.['@github/copilot-sdk'];
const expectedCliVersion = runnerPackage.overrides?.['@github/copilot'];

if (!expectedSdkVersion || !expectedCliVersion) {
  throw new Error(`${runnerDir}: expected exact @github/copilot-sdk dependency and @github/copilot override`);
}

const runnerRequire = createRequire(path.join(runnerDir, 'package.json'));
const sdkEntry = runnerRequire.resolve('@github/copilot-sdk');
const sdk = findPackageJson(sdkEntry, '@github/copilot-sdk');
if (sdk.packageJson.version !== expectedSdkVersion) {
  throw new Error(`SDK resolved to ${sdk.packageJson.version}; expected ${expectedSdkVersion}`);
}

const sdkRequire = createRequire(sdkEntry);
const cliPackagePath = sdkRequire.resolve('@github/copilot/package.json');
const cliPackage = readJson(cliPackagePath);
if (cliPackage.version !== expectedCliVersion) {
  throw new Error(`SDK-relative CLI resolved to ${cliPackage.version}; expected ${expectedCliVersion}`);
}

const sdkDistDir = path.join(path.dirname(sdk.path), 'dist');
let resolvedPlatform;
for (const packageName of platformPackageNames()) {
  const resolution = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `console.log(import.meta.resolve(${JSON.stringify(`${packageName}/sdk`)}))`],
    { cwd: sdkDistDir, encoding: 'utf8' },
  );
  if (resolution.status === 0) {
    const entry = fileURLToPath(resolution.stdout.trim());
    resolvedPlatform = findPackageJson(entry, packageName);
    break;
  }
  // The SDK tries glibc before musl on Linux; mirror that fallback order.
}

if (!resolvedPlatform) {
  throw new Error(`Could not resolve an SDK-relative Copilot platform package for ${process.platform}/${process.arch}`);
}
if (resolvedPlatform.packageJson.version !== expectedCliVersion) {
  throw new Error(
    `SDK-relative platform package resolved to ${resolvedPlatform.packageJson.version}; expected ${expectedCliVersion}`,
  );
}

console.log(
  `Verified ${path.relative(process.cwd(), runnerDir) || '.'}: SDK ${sdk.packageJson.version}, CLI ${cliPackage.version}, ${resolvedPlatform.packageJson.name} ${resolvedPlatform.packageJson.version}`,
);

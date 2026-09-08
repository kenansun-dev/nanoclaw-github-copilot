import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { runtimePlatform, verifyCopilotInstall } from '../scripts/verify-copilot-install.mjs';

const EXPECTED_SDK_VERSION = '1.0.13';
const NODE_ENGINE = '^20.19.0 || >=22.12.0';
const PACKAGES = ['.', 'container/agent-runner-ghc', 'container/agent-runner'];
const PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'linuxmusl-arm64',
  'linuxmusl-x64',
  'win32-arm64',
  'win32-x64',
];

interface LockPackage {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, LockPackage>;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const expectedPlatforms = Object.fromEntries(
  PLATFORMS.map((host) => [`@github/copilot-sdk-${host}`, EXPECTED_SDK_VERSION]),
);

describe('GitHub Copilot SDK dependency pin', () => {
  it('keeps the Bun Docker install and published package in sync', () => {
    const bunLock = fs.readFileSync('container/agent-runner/bun.lock', 'utf8');
    const dockerfile = fs.readFileSync('container/Dockerfile', 'utf8');
    const rootPackage = readJson('package.json');

    expect(bunLock).toContain(`"@github/copilot-sdk": "${EXPECTED_SDK_VERSION}"`);
    expect(bunLock).not.toMatch(/"@github\/copilot(?:"|-linux|-darwin|-win32)/);
    for (const name of Object.keys(expectedPlatforms)) {
      expect(bunLock).toContain(`"${name}@${EXPECTED_SDK_VERSION}"`);
    }
    expect(rootPackage.files).toContain('container/agent-runner/bun.lock');
    expect(rootPackage.files).toContain('scripts/verify-copilot-install.mjs');
    expect(dockerfile).toMatch(/ARG PNPM_VERSION=\d+\.\d+\.\d+/);
    expect(dockerfile).toContain('ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"');
    expect(dockerfile).toContain('npm install -g "pnpm@${PNPM_VERSION}"');
    expect(dockerfile).toContain("-name 'agent-browser-linux-*' -exec chmod 0755 {} +");
  });

  it('pins the root pnpm importer and all native packages without a CLI dependency', () => {
    const lock = parseYaml(fs.readFileSync('pnpm-lock.yaml', 'utf8'));
    expect(lock.importers['.'].dependencies['@github/copilot-sdk']).toEqual({
      specifier: EXPECTED_SDK_VERSION,
      version: EXPECTED_SDK_VERSION,
    });
    expect(lock.snapshots[`@github/copilot-sdk@${EXPECTED_SDK_VERSION}`].optionalDependencies).toEqual(
      expectedPlatforms,
    );
    for (const name of Object.keys(expectedPlatforms)) {
      expect(lock.packages[`${name}@${EXPECTED_SDK_VERSION}`]).toBeDefined();
    }
    expect(Object.keys(lock.packages).some((key) => key.startsWith('@github/copilot@'))).toBe(false);
  });

  for (const directory of PACKAGES) {
    it(`${directory} resolves one reproducible SDK/native runtime version`, () => {
      const packageJson = readJson(path.join(directory, 'package.json'));
      const lock = readJson(path.join(directory, 'package-lock.json')) as PackageLock;
      const entries = Object.entries(lock.packages);

      expect(packageJson.dependencies['@github/copilot-sdk']).toBe(EXPECTED_SDK_VERSION);
      expect(packageJson.dependencies['@github/copilot']).toBeUndefined();
      expect(packageJson.overrides?.['@github/copilot']).toBeUndefined();
      expect(packageJson.engines.node).toBe(NODE_ENGINE);
      expect(lock.packages[''].dependencies?.['@github/copilot-sdk']).toBe(EXPECTED_SDK_VERSION);

      const sdkEntries = entries.filter(([key]) => key.endsWith('node_modules/@github/copilot-sdk'));
      expect(sdkEntries.map(([, value]) => value.version)).toEqual([EXPECTED_SDK_VERSION]);
      expect(sdkEntries[0][1].optionalDependencies).toEqual(expectedPlatforms);
      for (const name of Object.keys(expectedPlatforms)) {
        expect(lock.packages[`node_modules/${name}`]?.version).toBe(EXPECTED_SDK_VERSION);
      }
      expect(
        entries.filter(([key]) => /node_modules\/@github\/copilot(?:$|-(?:darwin|linux|linuxmusl|win32)-)/.test(key)),
      ).toEqual([]);
    });
  }
});

const fixtures: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(platform = 'linux-x64', nested = false) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-sdk-pin-'));
  fixtures.push(dir);
  writeJson(path.join(dir, 'package.json'), { dependencies: { '@github/copilot-sdk': EXPECTED_SDK_VERSION } });
  const sdkDir = path.join(dir, 'node_modules/@github/copilot-sdk');
  writeJson(path.join(sdkDir, 'package.json'), {
    name: '@github/copilot-sdk',
    version: EXPECTED_SDK_VERSION,
    main: './dist/index.js',
    optionalDependencies: expectedPlatforms,
  });
  fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
  // A verifier must resolve metadata only. Importing the SDK would throw.
  fs.writeFileSync(path.join(sdkDir, 'dist/index.js'), 'throw new Error("SDK MUST NOT EXECUTE");');
  const platformDir = path.join(nested ? sdkDir : dir, `node_modules/@github/copilot-sdk-${platform}`);
  writeJson(path.join(platformDir, 'package.json'), {
    name: `@github/copilot-sdk-${platform}`,
    version: EXPECTED_SDK_VERSION,
  });
  const prebuild = path.join(platformDir, 'prebuilds', platform);
  fs.mkdirSync(prebuild, { recursive: true });
  const wrapper = path.join(prebuild, platform.startsWith('win32-') ? 'copilot-runtime.exe' : 'copilot-runtime');
  fs.writeFileSync(wrapper, 'NOT AN EXECUTABLE; metadata verification only');
  fs.writeFileSync(path.join(prebuild, 'runtime.node'), 'NOT A NATIVE LIBRARY');
  return { dir, sdkDir, platformDir, prebuild, wrapper };
}

// Keep missing-package tests independent of native packages installed above
// the fixture, including when the suite runs on Windows/arm64 or musl itself.
function hideAncestorPlatforms(dir: string) {
  const exists = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => {
    const value = String(file);
    if (value.includes(`${path.sep}@github${path.sep}copilot-sdk-`) && !value.startsWith(dir + path.sep)) return false;
    return exists(file);
  });
}

const linux = { platform: 'linux', arch: 'x64', musl: false };

describe('installation verifier (never launches CLI/native runtime)', () => {
  for (const platform of PLATFORMS) {
    it(`accepts the real 1.0.13 file layout for ${platform}`, () => {
      const f = fixture(platform);
      const [os, arch] = platform.split('-');
      const host = { platform: os === 'linuxmusl' ? 'linux' : os, arch, musl: os === 'linuxmusl' };
      expect(runtimePlatform(host.platform, host.arch, host.musl)).toBe(platform);
      expect(verifyCopilotInstall(f.dir, host)).toContain(`@github/copilot-sdk-${platform} 1.0.13`);
    });
  }

  it('uses SDK-relative resolution instead of accepting a hoisted wrong version', () => {
    const f = fixture('linux-x64', true);
    writeJson(path.join(f.dir, 'node_modules/@github/copilot-sdk-linux-x64/package.json'), {
      name: '@github/copilot-sdk-linux-x64',
      version: '1.0.8',
    });
    expect(verifyCopilotInstall(f.dir, linux)).toContain('1.0.13');
    writeJson(path.join(f.platformDir, 'package.json'), {
      name: '@github/copilot-sdk-linux-x64',
      version: '1.0.8',
    });
    expect(() => verifyCopilotInstall(f.dir, linux)).toThrow(/SDK-relative.*1.0.8.*expected 1.0.13/);
  });

  it('rejects a non-exact manifest pin', () => {
    const f = fixture();
    writeJson(path.join(f.dir, 'package.json'), { dependencies: { '@github/copilot-sdk': '^1.0.13' } });
    expect(() => verifyCopilotInstall(f.dir, linux)).toThrow(/expected exact/);
  });

  it('rejects a stale installed SDK even in the same major.minor', () => {
    const f = fixture();
    const manifest = readJson(path.join(f.sdkDir, 'package.json'));
    writeJson(path.join(f.sdkDir, 'package.json'), { ...manifest, version: '1.0.8' });
    expect(() => verifyCopilotInstall(f.dir, linux)).toThrow(/SDK resolved to 1.0.8; expected 1.0.13/);
  });

  it('rejects mismatched native optional dependency metadata', () => {
    const f = fixture();
    const manifest = readJson(path.join(f.sdkDir, 'package.json'));
    manifest.optionalDependencies['@github/copilot-sdk-linux-x64'] = '1.0.8';
    writeJson(path.join(f.sdkDir, 'package.json'), manifest);
    expect(() => verifyCopilotInstall(f.dir, linux)).toThrow(/must pin/);
  });

  it('rejects wrong package identity even if its version matches', () => {
    const f = fixture();
    writeJson(path.join(f.platformDir, 'package.json'), { name: 'wrong-package', version: EXPECTED_SDK_VERSION });
    expect(() => verifyCopilotInstall(f.dir, linux)).toThrow(/SDK-relative.*wrong-package/);
  });

  it('rejects a missing platform package despite an old CLI package being present', () => {
    const f = fixture('win32-arm64');
    hideAncestorPlatforms(f.dir);
    fs.rmSync(f.platformDir, { recursive: true });
    writeJson(path.join(f.dir, 'node_modules/@github/copilot-win32-arm64/package.json'), {
      name: '@github/copilot-win32-arm64',
      version: '1.0.83',
    });
    expect(() => verifyCopilotInstall(f.dir, { platform: 'win32', arch: 'arm64' })).toThrow(
      /Could not resolve SDK-relative.*optional dependencies/,
    );
  });

  it('does not fall back to glibc on a musl host', () => {
    const f = fixture('linux-arm64');
    hideAncestorPlatforms(f.dir);
    expect(() => verifyCopilotInstall(f.dir, { platform: 'linux', arch: 'arm64', musl: true })).toThrow(
      /copilot-sdk-linuxmusl-arm64/,
    );
  });

  for (const file of ['copilot-runtime', 'runtime.node']) {
    for (const invalid of ['missing', 'empty', 'directory']) {
      it(`rejects ${invalid} ${file}`, () => {
        const f = fixture();
        const target = path.join(f.prebuild, file);
        fs.unlinkSync(target);
        if (invalid === 'empty') fs.writeFileSync(target, '');
        if (invalid === 'directory') fs.mkdirSync(target);
        expect(() => verifyCopilotInstall(f.dir, linux)).toThrow(/runtime file missing or empty/);
      });
    }
  }

  it('rejects unsupported architectures and platforms explicitly', () => {
    expect(() => runtimePlatform('linux', 'ia32', false)).toThrow(/architecture/);
    expect(() => runtimePlatform('freebsd', 'x64', false)).toThrow(/platform/);
  });

  it('supports a pnpm-style SDK symlink', () => {
    const f = fixture();
    const virtualDir = path.join(f.dir, 'node_modules/.pnpm/sdk/node_modules/@github/copilot-sdk');
    fs.mkdirSync(path.dirname(virtualDir), { recursive: true });
    fs.renameSync(f.sdkDir, virtualDir);
    fs.symlinkSync(virtualDir, f.sdkDir, process.platform === 'win32' ? 'junction' : 'dir');
    expect(verifyCopilotInstall(f.dir, linux)).toContain('SDK 1.0.13');
  });

  it('runs the actual verifier command without executing any SDK/runtime code', () => {
    const f = fixture(runtimePlatform());
    const verifier = path.resolve('scripts/verify-copilot-install.mjs');
    const result = spawnSync(process.execPath, [verifier, f.dir], { encoding: 'utf8', timeout: 10_000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('runtime wrapper + runtime.node present');
    fs.truncateSync(f.wrapper, 0);
    const failure = spawnSync(process.execPath, [verifier, f.dir], { encoding: 'utf8', timeout: 10_000 });
    expect(failure.status).not.toBe(0);
    expect(failure.stderr).toContain('runtime file missing or empty');
  });
});

describe('postinstall exact verification integration', () => {
  function postinstallFixture() {
    const root = fixture(runtimePlatform());
    for (const runner of PACKAGES.slice(1)) {
      const source = fixture(runtimePlatform());
      fs.cpSync(source.dir, path.join(root.dir, runner), { recursive: true });
    }
    const scripts = path.join(root.dir, 'scripts');
    fs.mkdirSync(scripts);
    for (const name of ['postinstall.mjs', 'verify-copilot-install.mjs']) {
      fs.copyFileSync(path.resolve('scripts', name), path.join(scripts, name));
    }
    const preload = path.join(root.dir, 'stub-process.mjs');
    // All package installation/compilation is stubbed; the actual verifier
    // still inspects the fixture files. No CLI or package manager may launch.
    fs.writeFileSync(
      preload,
      `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      cp.execSync = (command) => {
        if (process.env.TEST_INSTALL_FAIL === '1' && command.startsWith('npm install')) {
          throw new Error('fixture install failure');
        }
        if (!command.startsWith('npm install') && command !== 'npx tsc') {
          throw new Error('unexpected subprocess');
        }
        return '';
      };
      syncBuiltinESMExports();
    `,
    );
    const run = (fail = false) =>
      spawnSync(process.execPath, ['--import', preload, path.join(scripts, 'postinstall.mjs')], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, TEST_INSTALL_FAIL: fail ? '1' : '0' },
      });
    return { ...root, run };
  }

  it('verifies root and both runners after a successful install', () => {
    const f = postinstallFixture();
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout.match(/runtime wrapper \+ runtime.node present/g)).toHaveLength(3);
  });

  it('fails even with valid SDK files when npm installation failed', () => {
    const f = postinstallFixture();
    const result = f.run(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture install failure');
    expect(result.stdout).not.toContain('NanoClaw installed!');
  });

  it('fails for a damaged runner runtime despite a healthy root SDK', () => {
    const f = postinstallFixture();
    fs.truncateSync(path.join(f.dir, 'container/agent-runner', path.relative(f.dir, f.wrapper)), 0);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime file missing or empty');
  });

  it('fails for a stale root SDK even when both runners are correct', () => {
    const f = postinstallFixture();
    const manifest = readJson(path.join(f.sdkDir, 'package.json'));
    writeJson(path.join(f.sdkDir, 'package.json'), { ...manifest, version: '1.0.8' });
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SDK resolved to 1.0.8; expected 1.0.13');
  });
});

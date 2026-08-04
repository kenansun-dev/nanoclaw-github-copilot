import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXPECTED_SDK_VERSION = '1.0.8';
const EXPECTED_CLI_VERSION = '1.0.73';
const RUNNERS = ['container/agent-runner-ghc', 'container/agent-runner'];

interface LockPackage {
  version?: string;
}

interface PackageLock {
  packages: Record<string, LockPackage>;
}

describe('GitHub Copilot SDK/CLI dependency pin', () => {
  for (const runner of RUNNERS) {
    it(`${runner} resolves one reproducible SDK/CLI version`, () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(runner, 'package.json'), 'utf8'));
      const lock = JSON.parse(fs.readFileSync(path.join(runner, 'package-lock.json'), 'utf8')) as PackageLock;
      const entries = Object.entries(lock.packages);

      expect(packageJson.dependencies['@github/copilot-sdk']).toBe(EXPECTED_SDK_VERSION);
      expect(packageJson.overrides['@github/copilot']).toBe(EXPECTED_CLI_VERSION);

      const sdkEntries = entries.filter(([key]) => key.endsWith('node_modules/@github/copilot-sdk'));
      const cliEntries = entries.filter(([key]) => key.endsWith('node_modules/@github/copilot'));
      const platformEntries = entries.filter(([key]) =>
        /node_modules\/@github\/copilot-(?:darwin|linux|linuxmusl|win32)-(?:arm64|x64)$/.test(key),
      );

      expect(sdkEntries.map(([, value]) => value.version)).toEqual([EXPECTED_SDK_VERSION]);
      expect(cliEntries.map(([, value]) => value.version)).toEqual([EXPECTED_CLI_VERSION]);
      expect(platformEntries.length).toBeGreaterThan(0);
      expect(new Set(platformEntries.map(([, value]) => value.version))).toEqual(new Set([EXPECTED_CLI_VERSION]));
    });
  }
});

// Optional Linux-only native smoke. Compile both runners first; no install needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
if (process.argv[2] !== '--isolated') {
  assert.equal(process.platform, 'linux', 'This probe requires Linux network namespaces');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-plugin-native-'));
  try {
    const result = spawnSync(
      'unshare',
      [
        '--user',
        '--map-root-user',
        '--net',
        process.execPath,
        script,
        '--isolated',
        fs.readlinkSync('/proc/self/ns/net'),
      ],
      {
        cwd: home,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, '.config'),
          XDG_CACHE_HOME: path.join(home, '.cache'),
          XDG_DATA_HOME: path.join(home, '.local/share'),
          COPILOT_TELEMETRY_DISABLED: '1',
        },
        stdio: 'inherit',
        timeout: 180_000,
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Isolated native probe failed (signal=${result.signal})`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
} else {
  assert.match(process.argv[3] ?? '', /^net:\[\d+\]$/, 'Missing parent network namespace');
  assert.notEqual(
    fs.readlinkSync('/proc/self/ns/net'),
    process.argv[3],
    'Refusing to start without a separate network namespace',
  );
  const home = os.homedir();
  assert.equal(process.cwd(), home);
  assert.match(path.basename(home), /^ncl-plugin-native-/);
  const dirs = Array.from({ length: 65 }, (_, i) => {
    const dir = path.join(home, `plugin-${i}`);
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(
      path.join(dir, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: `fixture-${i}`, version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(dir, 'agents', `fixture-${i}.md`), `Fixture ${i}; no inference requested.`);
    return dir;
  });
  const loadModule = (file) => import(pathToFileURL(path.join(root, file)).href);
  for (const runner of ['agent-runner', 'agent-runner-ghc']) {
    const pkg = `container/${runner}`;
    const { CopilotClient } = await loadModule(`${pkg}/node_modules/@github/copilot-sdk/dist/index.js`);
    const { resolvePluginDirectories } = await loadModule(`${pkg}/dist/plugin-directories.js`);
    const { loadPluginAgents } = await loadModule(
      `${pkg}/dist/${runner === 'agent-runner' ? 'providers/' : ''}load-plugin-agents.js`,
    );
    const options = (paths, label) => ({
      builtinPluginDirectories: paths,
      baseDirectory: path.join(home, `${runner}-${label}`),
      workingDirectory: home,
      useLoggedInUser: false,
      mode: 'empty',
      env: { ...process.env },
    });
    assert.throws(() => new CopilotClient(options(['plugin-0'], 'relative-control')), /absolute/);
    for (const count of [64, 65]) {
      const warnings = [];
      const input = dirs.slice(0, count);
      const raw = input.flatMap((dir) => [path.relative(home, dir), dir]).join(path.delimiter);
      const resolved = resolvePluginDirectories(raw, (msg) => warnings.push(msg));
      assert.deepEqual(resolved.pluginDirs, input);
      assert.deepEqual(resolved.builtinPluginDirectories, input.slice(0, 64));
      assert.equal(warnings.length, count > 64 ? 1 : 0);
      if (count > 64) assert.ok(warnings[0].includes(dirs[64]));
      assert.deepEqual(
        loadPluginAgents(resolved.pluginDirs).map((agent) => agent.pluginDir),
        input,
      );
      const client = new CopilotClient(options(resolved.builtinPluginDirectories, String(count)));
      try {
        await client.start();
        const status = await client.getStatus();
        console.log(
          JSON.stringify({
            runner,
            input: count,
            native: resolved.builtinPluginDirectories.length,
            fallback: input.length,
            warnings: warnings.length,
            result: 'started',
            ...status,
          }),
        );
      } finally {
        await client.stop();
      }
    }
    const rawClient = new CopilotClient(options(dirs, 'raw-65-control'));
    try {
      await assert.rejects(rawClient.start(), /plugins\.builtin\.set accepts at most 64 paths/);
      console.log(JSON.stringify({ runner, input: 65, policy: 'raw control', result: 'rejected as expected' }));
    } finally {
      await rawClient.stop();
    }
  }
}

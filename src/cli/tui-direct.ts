/**
 * nanoclaw tui — interactive terminal chat using the default agent
 *
 * Spawns agent-runner-ghc directly on the host with a readline-based TUI.
 * Uses the same ContainerInput/Output protocol as host-runner.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

import { loadConfig, saveConfig } from '../config-loader.js';
import { resolveGithubToken, isGHCProvider } from '../config-extensions.js';
import { resolveWorkspace, paths as wsPaths } from '../workspace.js';

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
  model?: string;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'thinking';
  result: string | null;
  newSessionId?: string;
  error?: string;
  partial?: boolean;
  thinking?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per query

export async function runTuiDirect(_args: string[]): Promise<void> {
  // Check for --query (non-interactive single query)
  const queryIdx = _args.indexOf('--query');
  const singleQuery =
    queryIdx !== -1
      ? _args
          .slice(queryIdx + 1)
          .filter((a) => a !== '--model' && a !== '--think')
          .filter(
            (a, i, arr) =>
              !(
                i > 0 &&
                (arr[i - 1] === '--model' || arr[i - 1] === '--think')
              ),
          )
          .join(' ')
          .trim()
      : '';

  // Parse --model and --think overrides
  const modelIdx = _args.indexOf('--model');
  const modelOverride = modelIdx !== -1 ? _args[modelIdx + 1] : undefined;
  const thinkIdx = _args.indexOf('--think');
  const thinkOverride = thinkIdx !== -1 ? _args[thinkIdx + 1] : undefined;

  const config = loadConfig();
  const agent = config.agents.defaults;
  const tuiCfg = config.tui || {};

  const ws = resolveWorkspace();
  const groupFolder = 'tui-session';
  const groupDir = path.join(ws, 'groups', groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  // IPC directories
  const ipcDir = path.join(ws, 'ipc', groupFolder);
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // TUI config overrides agent defaults; CLI args override everything
  const assistantName = tuiCfg.name || agent.name || 'Nanoclaw';
  const model =
    modelOverride ||
    tuiCfg.model ||
    agent.model ||
    'github-copilot/claude-sonnet-4';
  const thinkLevel = thinkOverride || tuiCfg.thinkLevel || agent.thinkLevel;
  const mode = tuiCfg.mode || agent.mode || 'host';

  if (!singleQuery) {
    console.log(`\n  ${assistantName} — Terminal Chat`);
    console.log(
      `  Model: ${model}${thinkLevel ? ` (think: ${thinkLevel})` : ''} [${mode}]`,
    );
    console.log(`  Commands: /new /think <level> /quit\n`);
  }

  // Only create readline for interactive mode
  const rl = singleQuery
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

  let sessionId: string | undefined;
  let activeChild: ChildProcess | null = null;

  // Ctrl+C: kill active query or exit
  process.on('SIGINT', () => {
    if (activeChild && !activeChild.killed) {
      console.log('\n⏹ Cancelled.');
      try {
        process.kill(-activeChild.pid!, 'SIGTERM');
      } catch {
        activeChild.kill('SIGTERM');
      }
      activeChild = null;
    } else {
      console.log('\nBye 👋\n');
      rl?.close();
      process.exit(0);
    }
  });

  const prompt = (): Promise<string> =>
    new Promise((resolve) => {
      process.stdout.write('\x1b[36myou>\x1b[0m ');
      rl!.once('line', (answer) => resolve(answer));
    });

  // Single query mode: skip interactive loop
  if (singleQuery) {
    const result = await runQuery({
      prompt: singleQuery,
      sessionId,
      model,
      thinkLevel,
      mode,
      groupDir,
      ipcDir,
      groupFolder: 'tui-ask',
      assistantName: 'Nanoclaw',
      onChild: () => {},
    });
    if (result.result) {
      // Show thinking if present
      if (result.thinking) {
        console.log('\n\x1b[90m\ud83e\udde0 Thinking:\x1b[0m');
        for (const line of result.thinking.split('\n')) {
          console.log(`\x1b[90m> ${line}\x1b[0m`);
        }
        console.log('');
      }
      console.log(result.result);
    }
    if (result.error) {
      console.error(`Error: ${result.error}`);
    }
    rl?.close();
    return;
  }

  while (true) {
    const userInput = await prompt();
    const trimmed = userInput.trim();

    if (!trimmed) continue;

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('\nBye 👋\n');
      rl?.close();
      process.exit(0);
    }

    if (trimmed === '/new' || trimmed === '/reset') {
      sessionId = undefined;
      // Clear copilot session data
      const sessionDir = path.join(
        ws,
        'data',
        'sessions',
        groupFolder,
        '.copilot',
      );
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
      console.log('🔄 Session reset.\n');
      continue;
    }

    // /think command
    const thinkMatch = trimmed.match(
      /^\/think(?:\s+(off|low|medium|high|xhigh))?$/i,
    );
    if (thinkMatch) {
      const level = thinkMatch[1]?.toLowerCase();
      if (!level) {
        const current = loadConfig().agents?.defaults?.thinkLevel || 'off';
        console.log(`🧠 Think level: ${current}`);
        console.log('Usage: /think off|low|medium|high|xhigh\n');
      } else {
        const cfg = loadConfig();
        if (level === 'off') {
          delete cfg.agents.defaults.thinkLevel;
        } else {
          cfg.agents.defaults.thinkLevel = level as
            | 'low'
            | 'medium'
            | 'high'
            | 'xhigh';
        }
        saveConfig(cfg);
        console.log(`🧠 Think level: ${level}\n`);
      }
      continue;
    }

    // Pause readline during query (spinner interferes with readline prompt)
    rl?.pause();

    // Send to agent
    const result = await runQuery({
      prompt: trimmed,
      sessionId,
      groupFolder,
      groupDir,
      ipcDir,
      assistantName,
      model,
      mode,
      onChild: (child) => {
        activeChild = child;
      },
    });

    activeChild = null;

    // Resume readline
    rl?.resume();

    if (result.newSessionId) {
      sessionId = result.newSessionId;
    }

    if (result.status === 'error') {
      console.error(`\x1b[31mError: ${result.error}\x1b[0m\n`);
    } else if (result.result) {
      console.log(`\n\x1b[32m${assistantName}>\x1b[0m ${result.result}\n`);
    } else {
      console.log(''); // blank line after no-result success
    }
  }
}

interface QueryOptions {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  groupDir: string;
  ipcDir: string;
  assistantName: string;
  model: string;
  thinkLevel?: string;
  mode: 'host' | 'sandbox';
  onChild: (child: ChildProcess) => void;
}

async function runQuery(opts: QueryOptions): Promise<ContainerOutput> {
  // Sandbox mode: use container-runner (Docker)
  if (opts.mode === 'sandbox') {
    return runSandboxQuery(opts);
  }

  // Host mode: spawn agent-runner directly
  const isGHC = isGHCProvider();
  const runnerDir = isGHC ? 'agent-runner-ghc' : 'agent-runner';
  const runnerPath = path.join(
    PROJECT_ROOT,
    'container',
    runnerDir,
    'src',
    'index.ts',
  );

  if (!fs.existsSync(runnerPath)) {
    return {
      status: 'error',
      result: null,
      error: `Agent runner not found: ${runnerPath}`,
    };
  }

  // Build env
  const config = loadConfig();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NANOCLAW_HOST_MODE: '1',
    NANOCLAW_IPC_DIR: path.join(opts.ipcDir, 'input'),
    NANOCLAW_WORK_DIR: opts.groupDir,
    HOME: process.env.HOME || '/root',
  };

  if (isGHC) {
    const token = resolveGithubToken();
    if (token) env.COPILOT_GITHUB_TOKEN = token;

    const slash = opts.model.indexOf('/');
    if (slash > 0) env.COPILOT_MODEL = opts.model.substring(slash + 1);

    const thinkLevel = config.agents?.defaults?.thinkLevel;
    if (thinkLevel) env.COPILOT_THINK_LEVEL = thinkLevel;
  }

  // Skills
  const containerSkills = path.join(PROJECT_ROOT, 'container', 'skills');
  if (
    fs.existsSync(wsPaths.skills) &&
    fs.readdirSync(wsPaths.skills).length > 0
  ) {
    env.NANOCLAW_SKILLS_DIR = wsPaths.skills;
  } else if (fs.existsSync(containerSkills)) {
    env.NANOCLAW_SKILLS_DIR = containerSkills;
  }

  // MCP
  if (fs.existsSync(wsPaths.mcpConfig)) {
    env.NANOCLAW_MCP_CONFIG = wsPaths.mcpConfig;
  }

  // Resolve runner command: prefer tsx (dev), fall back to node + compiled JS (global install)
  const tsxExt = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', tsxExt);
  const hasTsx = fs.existsSync(tsxBin);

  let cmd: string;
  let cmdArgs: string[];
  let cmdCwd: string;

  if (hasTsx) {
    // Dev mode: use tsx with TypeScript source
    cmd = tsxBin;
    cmdArgs = [runnerPath];
    cmdCwd = path.dirname(path.dirname(runnerPath));
  } else {
    // Global install: use node with compiled dist/
    const distRunner = path.join(
      PROJECT_ROOT,
      'container',
      isGHC ? 'agent-runner-ghc' : 'agent-runner',
      'dist',
      'index.js',
    );
    if (fs.existsSync(distRunner)) {
      cmd = process.execPath; // node
      cmdArgs = [distRunner];
      cmdCwd = path.dirname(path.dirname(distRunner));
    } else {
      return {
        status: 'error',
        result: null,
        error: `Neither tsx nor compiled agent-runner found. Run from dev repo or rebuild package.`,
      };
    }
  }

  const containerInput: ContainerInput = {
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    groupFolder: opts.groupFolder,
    chatJid: 'tui-local',
    isMain: true,
    assistantName: opts.assistantName,
    model: opts.model.includes('/') ? opts.model.split('/')[1] : opts.model,
  };

  return new Promise<ContainerOutput>((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      env,
      cwd: cmdCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    opts.onChild(child);

    let stdout = '';
    let stderr = '';
    let hadOutput = false;
    let resolved = false;

    const closeSentinel = path.join(opts.ipcDir, 'input', '_close');

    child.stdin.write(JSON.stringify(containerInput));
    child.stdin.end();

    // Spinner
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    const spinTimer = setInterval(() => {
      process.stdout.write(
        `\r${spinner[spinIdx++ % spinner.length]} thinking...`,
      );
    }, 100);

    // Timeout
    const timeout = setTimeout(() => {
      if (!resolved) {
        clearInterval(spinTimer);
        process.stdout.write('\r\x1b[K');
        try {
          process.kill(-child.pid!, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        resolved = true;
        resolve({
          status: 'error',
          result: null,
          error: 'Query timed out (5 min)',
        });
      }
    }, QUERY_TIMEOUT_MS);

    const finish = (output: ContainerOutput) => {
      if (resolved) return;
      resolved = true;
      clearInterval(spinTimer);
      clearTimeout(timeout);
      process.stdout.write('\r\x1b[K');
      // Write close sentinel
      try {
        fs.writeFileSync(closeSentinel, '');
      } catch {
        /* ignore */
      }
      // Kill child process (needed for --ask single-query mode)
      try {
        if (child && !child.killed) {
          child.kill('SIGTERM');
        }
      } catch {
        /* */
      }
      resolve(output);
    };

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();

      let startIdx: number;
      while ((startIdx = stdout.indexOf(OUTPUT_START)) !== -1) {
        const endIdx = stdout.indexOf(OUTPUT_END, startIdx);
        if (endIdx === -1) break;

        const jsonStr = stdout
          .substring(startIdx + OUTPUT_START.length, endIdx)
          .trim();
        stdout =
          stdout.substring(0, startIdx) +
          stdout.substring(endIdx + OUTPUT_END.length);

        try {
          const output: ContainerOutput = JSON.parse(jsonStr);
          // Skip partial/thinking-only outputs — wait for final result
          if (
            output.partial ||
            (output.status === 'thinking' && !output.result)
          ) {
            continue;
          }
          hadOutput = true;
          finish(output);
        } catch {
          /* parse error, continue */
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (hadOutput) {
        finish({ status: 'success', result: null });
        return;
      }

      // Try remaining stdout
      const lastStart = stdout.lastIndexOf(OUTPUT_START);
      if (lastStart !== -1) {
        const lastEnd = stdout.indexOf(OUTPUT_END, lastStart);
        if (lastEnd !== -1) {
          const jsonStr = stdout
            .substring(lastStart + OUTPUT_START.length, lastEnd)
            .trim();
          try {
            finish(JSON.parse(jsonStr));
            return;
          } catch {
            /* fall through */
          }
        }
      }

      finish({
        status: 'error',
        result: null,
        error: stderr.trim()
          ? `Agent exited (${code}): ${stderr.trim().slice(-300)}`
          : `Agent exited with code ${code}`,
      });
    });

    child.on('error', (err) => {
      finish({
        status: 'error',
        result: null,
        error: `Spawn failed: ${err.message}`,
      });
    });
  });
}

/**
 * Run query in sandbox (Docker container) mode.
 * Uses container-runner for Docker-based execution.
 */
async function runSandboxQuery(opts: QueryOptions): Promise<ContainerOutput> {
  try {
    const { runContainerAgent } = await import('../container-runner.js');

    const input = {
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      groupFolder: opts.groupFolder,
      chatJid: 'tui-local',
      isMain: true,
      assistantName: opts.assistantName,
      model: opts.model.includes('/') ? opts.model.split('/')[1] : opts.model,
    };

    const group = {
      name: 'tui',
      folder: opts.groupFolder,
      isMain: true,
      trigger: '',
      added_at: new Date().toISOString(),
    };

    let lastOutput: ContainerOutput = {
      status: 'success',
      result: null,
    };

    // Spinner
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    const spinTimer = setInterval(() => {
      process.stdout.write(
        `\r${spinner[spinIdx++ % spinner.length]} thinking...`,
      );
    }, 100);

    const output = await runContainerAgent(
      group,
      input,
      (proc, name) => {
        opts.onChild(proc);
      },
      async (out) => {
        lastOutput = out;
      },
    );

    clearInterval(spinTimer);
    process.stdout.write('\r\x1b[K');

    return output.status === 'success' && output.result ? output : lastOutput;
  } catch (err: any) {
    return {
      status: 'error',
      result: null,
      error: `Sandbox mode failed: ${err.message}. Is Docker running?`,
    };
  }
}

/**
 * Host Runner — runs agent-runner directly on the host (no Docker).
 *
 * Same stdin/stdout protocol as container-runner: writes ContainerInput as JSON
 * to stdin, reads ContainerOutput from stdout between OUTPUT markers.
 *
 * Used when agents.defaults.mode === 'host'.
 */
import { ChildProcess, spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  CONTAINER_TIMEOUT,
  IDLE_TIMEOUT,
  TIMEZONE,
  getConfig,
} from './config.js';
import { resolveWorkspace, paths as wsPaths } from './workspace.js';
import {
  resolveAgentForChat,
  getAgentModelName,
  isAgentGHC,
  resolveGithubToken,
} from './config-extensions.js';
import type { AgentConfig } from './config-loader.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

// ─── Child PID tracking ────────────────────────────────────────────────────────────────

function agentPidsFile(): string {
  return path.join(resolveWorkspace(), 'state', 'agent-pids.json');
}

export function registerAgentPid(pid: number): void {
  try {
    const file = agentPidsFile();
    const pids: number[] = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf-8'))
      : [];
    if (!pids.includes(pid)) pids.push(pid);
    fs.writeFileSync(file, JSON.stringify(pids));
  } catch {
    /* best effort */
  }
}

/** Clear stale PIDs on nanoclaw startup */
export function clearAgentPids(): void {
  try {
    const file = agentPidsFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

export function unregisterAgentPid(pid: number): void {
  try {
    const file = agentPidsFile();
    if (!fs.existsSync(file)) return;
    const pids: number[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const updated = pids.filter((p) => p !== pid);
    fs.writeFileSync(file, JSON.stringify(updated));
  } catch {
    /* best effort */
  }
}

export function killAllAgentPids(): void {
  try {
    const file = agentPidsFile();
    if (!fs.existsSync(file)) return;
    const pids: number[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const pid of pids) {
      try {
        // Verify process still exists before killing
        process.kill(pid, 0);
        if (process.platform === 'win32') {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      } catch {
        /* already dead or doesn't exist */
      }
    }
    fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

/**
 * Resolve the path to the agent-runner entry point.
 */
function resolveAgentRunnerPath(agent: AgentConfig): string {
  const isGHC = isAgentGHC(agent);
  const runnerDir = isGHC ? 'agent-runner-ghc' : 'agent-runner';
  const pkgRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const distPath = path.join(
    pkgRoot,
    'container',
    runnerDir,
    'dist',
    'index.js',
  );
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Agent runner not compiled: ${distPath}. Run 'npm run build' first.`,
    );
  }
  return distPath;
}

/**
 * Run agent-runner as a local process on the host.
 * Same interface as runContainerAgent for drop-in replacement.
 */
export async function runHostAgent(
  group: {
    name: string;
    folder: string;
    isMain?: boolean;
    containerConfig?: { timeout?: number };
  },
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const agent = resolveAgentForChat(input.chatJid);

  // Prepare working directory
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Prepare session directory
  const sessionDirName = isAgentGHC(agent) ? '.copilot' : '.claude';
  const ws = resolveWorkspace();
  const sessionDir = path.join(
    ws,
    'data',
    'sessions',
    group.folder,
    sessionDirName,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  // GHC: Create managed copilot config.json with nanoclaw-controlled settings
  if (isAgentGHC(agent)) {
    const configFile = path.join(sessionDir, 'config.json');
    if (!fs.existsSync(configFile)) {
      const hostCopilotConfig = path.join(
        process.env.HOME || '/root',
        '.copilot',
        'config.json',
      );
      let baseConfig: Record<string, unknown> = {};
      if (fs.existsSync(hostCopilotConfig)) {
        try {
          baseConfig = JSON.parse(fs.readFileSync(hostCopilotConfig, 'utf-8'));
        } catch {
          // Ignore parse errors
        }
      }
      baseConfig.webSearch = true;
      fs.writeFileSync(configFile, JSON.stringify(baseConfig, null, 2) + '\n');
    }
  }

  // Prepare IPC directory
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'output'), { recursive: true });

  // Resolve runner path — prefer compiled dist, fall back to tsx in dev
  const runnerPath = resolveAgentRunnerPath(agent);
  const useTsx = runnerPath.endsWith('.ts');

  // Build environment
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TZ: TIMEZONE,
    // Override paths that agent-runner expects (container paths → host paths)
    NANOCLAW_HOST_MODE: '1',
    HOME: process.env.HOME || '/root',
  };

  // Auth token
  if (isAgentGHC(agent)) {
    const token = resolveGithubToken();
    if (token) {
      env.COPILOT_GITHUB_TOKEN = token;
    }
    const modelName = getAgentModelName(agent);
    if (modelName) {
      env.COPILOT_MODEL = modelName;
    }
    if (agent.thinkLevel) {
      env.COPILOT_THINK_LEVEL = agent.thinkLevel;
    }
    // Point GHC CLI to nanoclaw-managed config directory
    env.COPILOT_HOME = sessionDir;
    // Enable GitHub MCP server (web_search, issues, PRs, etc.) — default true for GHC
    if (agent.githubMcp !== false) {
      env.NANOCLAW_GITHUB_MCP = '1';
    }
  } else {
    // CC mode: uses Claude Agent SDK with native host auth (~/.claude/)
    // No token injection needed — CLI handles its own auth
    const modelName = getAgentModelName(agent);
    if (modelName) {
      env.CLAUDE_MODEL = modelName;
    }
    if (agent.thinkLevel) {
      env.CLAUDE_THINK_LEVEL = agent.thinkLevel;
    }
  }

  // Skills directory — prefer workspace skills, fall back to container/skills
  // Use package root (relative to this file) for npm-installed fallback
  const pkgRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const containerSkills = path.join(pkgRoot, 'container', 'skills');
  if (
    fs.existsSync(wsPaths.skills) &&
    fs.readdirSync(wsPaths.skills).length > 0
  ) {
    env.NANOCLAW_SKILLS_DIR = wsPaths.skills;
  } else if (fs.existsSync(containerSkills)) {
    env.NANOCLAW_SKILLS_DIR = containerSkills;
  }

  // MCP config
  if (fs.existsSync(wsPaths.mcpConfig)) {
    env.NANOCLAW_MCP_CONFIG = wsPaths.mcpConfig;
  }

  // IPC directory
  env.NANOCLAW_IPC_DIR = path.join(ipcDir, 'input');

  // Working directory (agent cwd)
  env.NANOCLAW_WORK_DIR = groupDir;

  // Global agent prompt template
  // GHC uses COPILOT.md if available, CC uses CLAUDE.md
  const groupType = group.isMain ? 'main' : 'global';
  const promptFilename = isAgentGHC(agent)
    ? fs.existsSync(path.join(pkgRoot, 'groups', groupType, 'COPILOT.md'))
      ? 'COPILOT.md'
      : 'CLAUDE.md'
    : 'CLAUDE.md';
  const globalClaudeMd = path.join(
    pkgRoot,
    'groups',
    groupType,
    promptFilename,
  );
  if (fs.existsSync(globalClaudeMd)) {
    env.NANOCLAW_GLOBAL_CLAUDE_MD = globalClaudeMd;
  }

  // Spawn command
  // Resolve tsx: try package node_modules, then global
  const tsxExt = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const tsxPkgRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const pkgTsx = path.join(tsxPkgRoot, 'node_modules', '.bin', tsxExt);
  let cmd: string;
  if (useTsx) {
    if (fs.existsSync(pkgTsx)) {
      cmd = pkgTsx;
    } else {
      // Fall back to global tsx
      cmd = tsxExt;
    }
  } else {
    cmd = 'node';
  }
  const args = [runnerPath];

  const processName = `nanoclaw-host-${group.folder.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      runner: runnerPath,
      isGHC: isAgentGHC(agent),
    },
    'Spawning host agent',
  );

  const child = spawn(cmd, args, {
    env,
    // Use agent-runner dir as cwd so tsx resolves node_modules correctly
    cwd: path.dirname(path.dirname(runnerPath)),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  onProcess(child, processName);

  // Track child PID for clean shutdown
  if (child.pid) registerAgentPid(child.pid);

  return new Promise<ContainerOutput>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let hadStreamingOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Host mode with idleTimeout 0: no hard timeout (agent stays alive forever)
    // Container mode or explicit timeout: use configTimeout or idleTimeout + grace
    const neverTimeout = IDLE_TIMEOUT <= 0;
    const timeoutMs = neverTimeout
      ? 0 // 0 = no timeout
      : Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Host agent timeout, killing',
      );
      // Kill the entire process group to avoid orphans
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          if (!child.killed) child.kill('SIGKILL');
        }
      }, 10_000);
    };

    let timeout: ReturnType<typeof setTimeout> | null = neverTimeout
      ? null
      : setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      if (neverTimeout) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Write input to stdin
    const inputJson = JSON.stringify(input);
    child.stdin.write(inputJson);
    child.stdin.end();

    let resolved = false;

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();

      // Check for streaming output markers
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
          hadStreamingOutput = true;
          resetTimeout();

          if (onOutput) {
            onOutput(output).catch((err) => {
              logger.error(
                { error: err },
                'Error in host agent output callback',
              );
            });
          }

          // Query-complete signal: result is null with newSessionId
          // This means agent finished the query and is waiting for IPC
          if (
            !resolved &&
            output.result === null &&
            output.newSessionId &&
            !output.partial
          ) {
            resolved = true;
            resolve(output);
          }
        } catch (err) {
          logger.error(
            { error: err, json: jsonStr.substring(0, 200) },
            'Failed to parse host agent output',
          );
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      // Log stderr lines prefixed with [agent-runner] for visibility
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        logger.debug({ group: group.name }, `[host-agent] ${line}`);
      }
    });

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (child.pid) unregisterAgentPid(child.pid);
      const duration = Date.now() - startTime;

      if (resolved) {
        logger.info(
          { group: group.name, processName, code, duration },
          'Host agent process ended (output already delivered)',
        );
        return;
      }

      if (timedOut) {
        logger.error(
          { group: group.name, processName, duration },
          'Host agent timed out',
        );
        resolve({
          status: 'error',
          result: null,
          error: 'Host agent timed out',
        });
        return;
      }

      // Try to extract final output from remaining stdout
      const lastStart = stdout.lastIndexOf(OUTPUT_START);
      if (lastStart !== -1) {
        const lastEnd = stdout.indexOf(OUTPUT_END, lastStart);
        if (lastEnd !== -1) {
          const jsonStr = stdout
            .substring(lastStart + OUTPUT_START.length, lastEnd)
            .trim();
          try {
            const output: ContainerOutput = JSON.parse(jsonStr);
            logger.info(
              { group: group.name, processName, duration, code },
              'Host agent completed',
            );
            resolve(output);
            return;
          } catch {
            /* fall through */
          }
        }
      }

      if (hadStreamingOutput && code === 0) {
        logger.info(
          { group: group.name, processName, duration },
          'Host agent completed (streaming mode)',
        );
        resolve({
          status: 'success',
          result: null,
        });
        return;
      }

      // Error case
      const errorMsg = stderr.trim()
        ? `Host agent exited with code ${code}: ${stderr.trim().slice(-500)}`
        : `Host agent exited with code ${code}`;

      logger.error(
        {
          group: group.name,
          processName,
          code,
          duration,
          stderr: stderr.slice(-500),
        },
        'Host agent error',
      );

      resolve({
        status: 'error',
        result: null,
        error: errorMsg,
      });
    });

    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Host agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn host agent: ${err.message}`,
      });
    });
  });
}

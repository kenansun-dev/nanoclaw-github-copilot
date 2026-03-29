/**
 * Host Runner — runs agent-runner directly on the host (no Docker).
 *
 * Same stdin/stdout protocol as container-runner: writes ContainerInput as JSON
 * to stdin, reads ContainerOutput from stdout between OUTPUT markers.
 *
 * Used when agents.defaults.mode === 'host'.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_TIMEOUT,
  IDLE_TIMEOUT,
  TIMEZONE,
  getConfig,
} from './config.js';
import { resolveAgentForChat, getAgentModelName, isAgentGHC, resolveGithubToken } from './config-extensions.js';
import type { AgentConfig } from './config-loader.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { paths as wsPaths } from './workspace.js';

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';


/**
 * Resolve the path to the agent-runner entry point.
 */
function resolveAgentRunnerPath(agent: AgentConfig): string {
  const isGHC = isAgentGHC(agent);
  const runnerDir = isGHC ? 'agent-runner-ghc' : 'agent-runner';
  // Try compiled JS first, fall back to TypeScript via tsx
  const distPath = path.join(
    process.cwd(),
    'container',
    runnerDir,
    'dist',
    'index.js',
  );
  const srcPath = path.join(
    process.cwd(),
    'container',
    runnerDir,
    'src',
    'index.ts',
  );
  // Always use source — dist may be stale and miss env var support
  return srcPath;
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
  const sessionDir = path.join(
    process.cwd(),
    'data',
    'sessions',
    group.folder,
    sessionDirName,
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  // Prepare IPC directory
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'output'), { recursive: true });

  // Resolve runner path
  const runnerPath = resolveAgentRunnerPath(agent);
  // Always use tsx for host mode — handles ESM resolution (vscode-jsonrpc/node etc)
  const useTsx = true;

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
  }

  // Skills directory — prefer workspace skills, fall back to container/skills
  // Use package root (relative to this file) for npm-installed fallback
  const pkgRoot = path.resolve(new URL('.', import.meta.url).pathname, '..');
  const containerSkills = path.join(pkgRoot, 'container', 'skills');
  if (fs.existsSync(wsPaths.skills) && fs.readdirSync(wsPaths.skills).length > 0) {
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

  // Global CLAUDE.md template
  const globalClaudeMd = path.join(
    process.cwd(),
    'groups',
    group.isMain ? 'main' : 'global',
    'CLAUDE.md',
  );
  if (fs.existsSync(globalClaudeMd)) {
    env.NANOCLAW_GLOBAL_CLAUDE_MD = globalClaudeMd;
  }

  // Spawn command
  const cmd = useTsx ? 'npx' : 'node';
  const args = useTsx ? ['tsx', runnerPath] : [runnerPath];

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
    cwd: groupDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  onProcess(child, processName);

  return new Promise<ContainerOutput>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let hadStreamingOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs =
      IDLE_TIMEOUT <= 0
        ? configTimeout
        : Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Host agent timeout, killing',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10_000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Write input to stdin
    const inputJson = JSON.stringify(input);
    child.stdin.write(inputJson);
    child.stdin.end();

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
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

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
      clearTimeout(timeout);
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

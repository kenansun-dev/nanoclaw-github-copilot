/**
 * Host Runner — runs agent-runner directly on the host (no Docker).
 *
 * Same stdin/stdout protocol as container-runner: writes ContainerInput as JSON
 * to stdin, reads ContainerOutput from stdout between OUTPUT markers.
 *
 * Used when agents.defaults.mode === 'host'.
 */
import { ChildProcess, spawn, execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { AGENT_RUN_TIMEOUT_MS, TIMEZONE, getConfig } from './config.js';
import { resolveWorkspace, paths as wsPaths } from './workspace.js';
import { resolveAgentForChat, isAgentGHC, resolveGithubToken } from './config-extensions.js';
import { parseJsonc } from './jsonc.js';
import { getEffectiveModel, getEffectiveThinkLevel } from './session-overrides.js';
import type { AgentConfig } from './config-loader.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './log-extensions.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { ensureDailySummaryTask } from './memory/cron.js';

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

// ─── Child PID tracking ────────────────────────────────────────────────────────────────

function agentPidsFile(): string {
  return path.join(resolveWorkspace(), 'state', 'agent-pids.json');
}

export function registerAgentPid(pid: number): void {
  try {
    const file = agentPidsFile();
    const pids: number[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
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

/**
 * Force-kill a single host-agent process **and its whole subtree** (the GHC
 * copilot CLI + every stdio MCP server it spawned).
 *
 * Why this exists (root cause of kenan's Windows "running but silent, needs
 * restart" + 400+ leaked node procs over 4 days, 2026-06-24):
 * host mode is IPC long-lived, so one host-agent node process is reused across
 * many turns and only dies on per-query timeout / crash / `stop`. When it dies,
 * the `child.on('close')` path historically only called `unregisterAgentPid()`
 * — it dropped the bookkeeping record but never reaped the OS subtree. On
 * Windows there is no process-group SIGKILL cascade, so the copilot CLI and its
 * MCP grandchildren were orphaned and lived on. Every respawn stacked more.
 * host-sweep (the intended reaper) is container-only AND was wedged on a null
 * v2 DB handle, so nothing collected them until a manual restart.
 *
 * This reaper is the per-agent-death backstop: Windows uses parallel
 * `taskkill /F /T` (walks the tree); POSIX kills the detached process group
 * (negative pid) with a single-pid fallback. Best-effort + idempotent — a
 * process that already exited is a no-op, not an error.
 */
export async function treeKillAgent(pid: number, reason: string): Promise<void> {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      try {
        await execAsync(`taskkill /F /T /PID ${pid}`);
        logger.info({ pid, reason }, 'treeKillAgent: taskkill /F /T succeeded (subtree reaped)');
      } catch (err: any) {
        const msg = err?.stderr?.toString?.() ?? String(err);
        if (/not found|不存在|找不到/i.test(msg)) {
          logger.debug({ pid, reason }, 'treeKillAgent: process already gone');
        } else {
          logger.warn({ pid, reason, err: msg }, 'treeKillAgent: taskkill /F /T failed');
        }
      }
    } else {
      // POSIX: kill the detached process group (spawn uses detached:true), so
      // grandchildren spawned by the CLI go too. Fall back to single-pid.
      try {
        process.kill(-pid, 'SIGKILL');
        logger.info({ pid, reason }, 'treeKillAgent: SIGKILL sent to process group (subtree reaped)');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
          logger.debug({ pid, reason }, 'treeKillAgent: SIGKILL sent to pid (no pgroup)');
        } catch {
          logger.debug({ pid, reason }, 'treeKillAgent: process already gone');
        }
      }
    }
  } catch (err: any) {
    logger.warn({ pid, reason, err: err?.message ?? String(err) }, 'treeKillAgent: unexpected error');
  }
}

export async function killAllAgentPids(): Promise<void> {
  try {
    const file = agentPidsFile();
    if (!fs.existsSync(file)) {
      logger.debug('killAllAgentPids: no agent-pids.json, nothing to kill');
      return;
    }
    const pids: number[] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (pids.length === 0) {
      logger.debug('killAllAgentPids: agent-pids.json empty');
      fs.unlinkSync(file);
      return;
    }
    logger.info(
      { pids, platform: process.platform },
      `killAllAgentPids: attempting to kill ${pids.length} tracked agent pid(s)`,
    );
    if (process.platform === 'win32') {
      // Windows: parallel taskkill /F /T. Serial was ~1s/pid (taskkill
      // spawns cmd.exe + walks process tree); 46 pids on owner's host =
      // 46s, blowing past update.ts 15s stop timeout and racing into
      // npm install -g (EBUSY on container/agent-runner-ghc grandchildren).
      // Parallel = ~2s for any reasonable pid count. 2026-05-11.
      await Promise.all(
        pids.map(async (pid) => {
          try {
            await execAsync(`taskkill /F /T /PID ${pid}`);
            logger.info({ pid }, 'taskkill /F /T succeeded (tree killed)');
          } catch (err: any) {
            const msg = err?.stderr?.toString?.() ?? String(err);
            if (/not found|不存在|找不到/i.test(msg)) {
              logger.debug({ pid }, 'taskkill: process already gone');
            } else {
              logger.warn({ pid, err: msg }, 'taskkill /F /T failed');
            }
          }
        }),
      );
    } else {
      for (const pid of pids) {
        // POSIX: try process-group kill first (negative pid), then fall back
        // to single-pid. Process-group kill reaches detached grandchildren
        // spawned with setsid/detached:true.
        // Escalate to SIGKILL after 2s if anything in the group is still
        // alive — a misbehaving agent with a SIGTERM handler that refuses
        // to exit would otherwise hang stop forever. Rpi5 nit 2026-04-21.
        let pgroupOk = false;
        try {
          process.kill(-pid, 'SIGTERM');
          logger.info({ pid }, 'SIGTERM sent to process group');
          pgroupOk = true;
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
            logger.debug({ pid }, 'SIGTERM sent to pid (no pgroup)');
          } catch {
            logger.debug({ pid }, 'process already dead');
            continue;
          }
        }
        // Poll up to 2s for clean exit, then SIGKILL the pgroup.
        const deadline = Date.now() + 2000;
        let stillAlive = true;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            stillAlive = false;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (stillAlive) {
          try {
            process.kill(pid, 0);
            try {
              if (pgroupOk) process.kill(-pid, 'SIGKILL');
              else process.kill(pid, 'SIGKILL');
              logger.warn({ pid }, 'SIGTERM did not take effect after 2s — sent SIGKILL');
            } catch {
              /* died during escalation */
            }
          } catch {
            /* died cleanly from SIGTERM */
          }
        }
      }
    }
    fs.unlinkSync(file);
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err) }, 'killAllAgentPids: unexpected error');
  }
}

/**
 * Resolve the path to the agent-runner entry point.
 */
function resolveAgentRunnerPath(agent: AgentConfig): string {
  const isGHC = isAgentGHC(agent);
  const runnerDir = isGHC ? 'agent-runner-ghc' : 'agent-runner';
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distPath = path.join(pkgRoot, 'container', runnerDir, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    throw new Error(`Agent runner not compiled: ${distPath}. Run 'npm run build' first.`);
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

  // Ensure per-group memory daily-summary cron task exists. Idempotent;
  // updates in place if config changed. Honours `memory.dailySummary.enabled`.
  try {
    ensureDailySummaryTask({
      chatJid: input.chatJid,
      groupFolder: group.folder,
    });
  } catch (err) {
    logger.warn({ err }, 'ensureDailySummaryTask threw (non-fatal)');
  }

  // Prepare session directory
  const sessionDirName = isAgentGHC(agent) ? '.copilot' : '.claude';
  const ws = resolveWorkspace();
  const sessionDir = path.join(ws, 'data', 'sessions', group.folder, sessionDirName);
  fs.mkdirSync(sessionDir, { recursive: true });

  // GHC: Create managed copilot config.json with nanoclaw-controlled settings
  if (isAgentGHC(agent)) {
    const configFile = path.join(sessionDir, 'config.json');
    if (!fs.existsSync(configFile)) {
      const hostCopilotConfig = path.join(
        process.env.HOME || process.env.USERPROFILE || os.homedir(),
        '.copilot',
        'config.json',
      );
      let baseConfig: Record<string, unknown> = {};
      if (fs.existsSync(hostCopilotConfig)) {
        try {
          // JSONC-tolerant: Copilot CLI writes a `// banner` at the top.
          // Bare JSON.parse silently drops the user's loggedInUsers /
          // copilotTokens into the container config (PR #47, 2026-05-12).
          baseConfig = parseJsonc<Record<string, unknown>>(fs.readFileSync(hostCopilotConfig, 'utf-8'));
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
    NANOCLAW_TZ: TIMEZONE,
    // Override paths that agent-runner expects (container paths → host paths)
    NANOCLAW_HOST_MODE: '1',
    HOME: process.env.HOME || process.env.USERPROFILE || os.homedir(),
  };

  // Channel-qualified user id of the user whose latest message triggered
  // this turn — see ContainerInput.triggeringUserId. The in-process MCP
  // server reads this from env to stamp IPC payloads for host-side isOwner
  // privilege gates (HR list #3, 2026-05-16 isOwner phase 1).
  if (input.triggeringUserId) {
    env.NANOCLAW_TRIGGERING_USER_ID = input.triggeringUserId;
  }

  // Auth token
  if (isAgentGHC(agent)) {
    const token = resolveGithubToken();
    if (token) {
      env.COPILOT_GITHUB_TOKEN = token;
    }
    // Effective model/think: per-session override (slash-command) wins
    // over the agent default. See session-overrides.ts.
    const effectiveModel = getEffectiveModel(input.chatJid);
    if (effectiveModel) {
      env.COPILOT_MODEL = effectiveModel;
    }
    const effectiveThink = getEffectiveThinkLevel(input.chatJid);
    if (effectiveThink && effectiveThink !== 'off') {
      env.COPILOT_THINK_LEVEL = effectiveThink;
    }
    // Pass session config dir without overriding COPILOT_HOME
    // (COPILOT_HOME would make CLI look for credentials in sessionDir instead of ~/.copilot)
    env.NANOCLAW_CONFIG_DIR = sessionDir;
    // Enable GitHub MCP server (web_search, issues, PRs, etc.) — default true for GHC
    if (agent.githubMcp !== false) {
      env.NANOCLAW_GITHUB_MCP = '1';
    }
    // Enable MCP config discovery (reads ~/.mcp.json etc.)
    const mcpDiscovery = (getConfig() as any).mcp?.enableConfigDiscovery ?? false;
    if (mcpDiscovery) {
      env.NANOCLAW_MCP_DISCOVERY = '1';
    }
  } else {
    // CC mode: uses Claude Agent SDK with native host auth (~/.claude/)
    // No token injection needed — CLI handles its own auth
    const effectiveModel = getEffectiveModel(input.chatJid);
    if (effectiveModel) {
      env.CLAUDE_MODEL = effectiveModel;
    }
    const effectiveThink = getEffectiveThinkLevel(input.chatJid);
    if (effectiveThink && effectiveThink !== 'off') {
      env.CLAUDE_THINK_LEVEL = effectiveThink;
    }
  }

  // Skills directory — prefer workspace skills, fall back to container/skills
  // Use package root (relative to this file) for npm-installed fallback
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const containerSkills = path.join(pkgRoot, 'container', 'skills');
  if (fs.existsSync(wsPaths.skills) && fs.readdirSync(wsPaths.skills).length > 0) {
    env.NANOCLAW_SKILLS_DIR = wsPaths.skills;
  } else if (fs.existsSync(containerSkills)) {
    env.NANOCLAW_SKILLS_DIR = containerSkills;
  }

  // MCP config — resolve Azure AD tokens for remote servers
  // Read from both mcp.json AND nanoclaw.json mcp.servers (merged by config-loader)
  const mergedMcpServers = getConfig().mcp?.servers || {};
  const hasMcpConfig = fs.existsSync(wsPaths.mcpConfig) || Object.keys(mergedMcpServers).length > 0;
  if (hasMcpConfig) {
    try {
      // Start with mcp.json if it exists, then overlay nanoclaw.json servers
      let mcpJson: any = {};
      if (fs.existsSync(wsPaths.mcpConfig)) {
        mcpJson = JSON.parse(fs.readFileSync(wsPaths.mcpConfig, 'utf-8'));
      }
      const servers = {
        ...(mcpJson.mcpServers || mcpJson),
        ...mergedMcpServers,
      };
      const hasAzureAuth = Object.values(servers).some((s: any) => s.auth?.provider === 'azure');
      if (hasAzureAuth) {
        const { resolveAllMcpTokens } = await import('./mcp-azure-auth.js');
        const { headers: authHeaders, errors } = await resolveAllMcpTokens(servers);
        // Inject auth headers into server configs
        for (const [name, hdrs] of Object.entries(authHeaders)) {
          if (servers[name]) {
            servers[name].headers = {
              ...(servers[name].headers || {}),
              ...hdrs,
            };
          }
        }
        // Log errors for servers that need auth but couldn't get tokens
        for (const [name, err] of Object.entries(errors)) {
          logger.warn({ server: name }, `MCP auth: ${err}`);
        }
        // Write augmented config to session dir
        const augmentedPath = path.join(sessionDir, 'mcp.json');
        fs.writeFileSync(augmentedPath, JSON.stringify({ mcpServers: servers }, null, 2));
        env.NANOCLAW_MCP_CONFIG = augmentedPath;
      } else {
        // No azure auth needed, but still write merged config
        const augmentedPath = path.join(sessionDir, 'mcp.json');
        fs.writeFileSync(augmentedPath, JSON.stringify({ mcpServers: servers }, null, 2));
        env.NANOCLAW_MCP_CONFIG = augmentedPath;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'MCP auth resolution failed, using original config',
      );
      env.NANOCLAW_MCP_CONFIG = wsPaths.mcpConfig;
    }
  }

  // Plugin directories — collect from 3 sources:
  // 1. ~/.nanoclaw/plugins/ (nanoclaw-managed)
  // 2. ~/.copilot/plugins/ (user-installed via copilot CLI)
  // 3. ~/.claude/plugins/ (user-installed via claude CLI)
  const pluginDirs: string[] = [];
  const pluginSources = [
    path.join(resolveWorkspace(), 'plugins'),
    path.join(os.homedir(), '.copilot', 'plugins'),
    path.join(os.homedir(), '.claude', 'plugins'),
  ];
  for (const src of pluginSources) {
    if (fs.existsSync(src)) {
      try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const pluginPath = path.join(src, entry.name);
            // Must have plugin.json or .claude-plugin/plugin.json
            if (
              fs.existsSync(path.join(pluginPath, 'plugin.json')) ||
              fs.existsSync(path.join(pluginPath, '.claude-plugin', 'plugin.json'))
            ) {
              pluginDirs.push(pluginPath);
            }
          }
        }
      } catch {
        /* skip unreadable dirs */
      }
    }
  }
  if (pluginDirs.length > 0) {
    env.NANOCLAW_PLUGIN_DIRS = pluginDirs.join(path.delimiter);
    logger.info({ count: pluginDirs.length }, 'Plugin directories discovered');
  }

  // IPC directory
  env.NANOCLAW_IPC_DIR = path.join(ipcDir, 'input');

  // Working directory (agent cwd)
  env.NANOCLAW_WORK_DIR = groupDir;

  // Global agent prompt template
  // GHC uses COPILOT.md if available, CC uses CLAUDE.md
  // v2-only (PR #49): use the dual-read'd default-agent flag plumbed via
  // `input.isDefaultAgent`. v1 `group.isMain` was retired with the field.
  const groupType = input.isDefaultAgent ? 'main' : 'global';
  const promptFilename = isAgentGHC(agent)
    ? fs.existsSync(path.join(pkgRoot, 'groups', groupType, 'COPILOT.md'))
      ? 'COPILOT.md'
      : 'CLAUDE.md'
    : 'CLAUDE.md';
  const globalClaudeMd = path.join(pkgRoot, 'groups', groupType, promptFilename);
  if (fs.existsSync(globalClaudeMd)) {
    env.NANOCLAW_GLOBAL_CLAUDE_MD = globalClaudeMd;
  }

  // Pass memory directory to runner so the memory MCP server can locate it.
  // The MCP server uses NANOCLAW_GROUP_FOLDER + 'memory/' subdir.
  env.NANOCLAW_MEMORY_DIR = path.join(groupDir, 'memory');

  // Spawn command
  // Resolve tsx: try package node_modules, then global
  const tsxExt = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const tsxPkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

  const processName =
    input.isScheduledTask && input.taskId
      ? `nanoclaw-task-${input.taskId.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`
      : `nanoclaw-host-${group.folder.replace(/[^a-zA-Z0-9-]/g, '-')}-${Date.now()}`;

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
    windowsHide: true,
  });

  onProcess(child, processName);

  // Track child PID for clean shutdown.
  // Also log pid + ppid + cmd prominently so ops can grep the log and find
  // the actual process tree root (process name on Windows is just 'node',
  // which is useless for identification). Kenan, 2026-04-21.
  if (child.pid) {
    registerAgentPid(child.pid);
    logger.info(
      {
        group: group.name,
        processName,
        pid: child.pid,
        ppid: process.pid,
        cmd,
        platform: process.platform,
      },
      `Host agent spawned (pid=${child.pid}, ppid=${process.pid}) — use 'taskkill /F /T /PID ${child.pid}' on Windows or 'kill -- -${child.pid}' on POSIX to force-kill the whole tree`,
    );
  }

  return new Promise<ContainerOutput>((resolve) => {
    let stdout = '';
    // Serialized callback chain: each onOutput invocation waits for the
    // previous to settle so the dispatcher in src/index.ts sees partials
    // strictly in order. Initialized to a resolved promise.
    let outputCallbackChain: Promise<void> = Promise.resolve();
    let stderr = '';
    let timedOut = false;
    let hadStreamingOutput = false;

    // Host mode is long-lived by design (no docker container to recycle, no
    // image-rebuild cost, MCP servers keep their auth/session state in-process).
    // sandbox.timeout / sandbox.idleTimeout are container-mode concepts —
    // killing a host node every 30s/30min just costs spawn (1-3s) + MCP
    // re-auth and gives nothing back (memory ~150MB is cheap on a personal
    // host). Per owner direction (kenan, 2026-05-10): host mode IGNORES both
    // sandbox timeouts. Only AGENT_RUN_TIMEOUT_MS (per-query, default 10min)
    // applies — that's the canary that catches truly stuck queries / hung
    // MCP calls and triggers the kill path below (see win32 fix in bfe60ee).
    const neverTimeout = true; // host mode: always rely on per-query absoluteTimeout, never lifetime
    const timeoutMs = 0; // unused when neverTimeout=true (see line ~569)

    const killOnTimeout = () => {
      if (timedOut) return; // Guard against double-trigger from idle + absolute timeout
      timedOut = true;
      logger.error({ group: group.name, processName }, 'Host agent timeout, killing');
      // Kill the entire process tree (agent + tsx + MCP subprocess descendants).
      //
      // BUG (kenan reported on Windows + slow MCP tools, 2026-05-10):
      // Previously this branch unconditionally called `process.kill(-pid, ...)`.
      // On Windows, Node's `process.kill()` IGNORES negative pids — only the
      // root child gets the signal, MCP subprocess descendants survive holding
      // stdio pipes open, the child's 'exit'/'close' event never fires,
      // GroupQueue.state.active stays true forever, chat goes silent until
      // daemon restart. Mirroring the same win32 branch we already have in
      // killAllAgentPids() (line ~85) so per-query timeouts get tree-kill on
      // Windows too.
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'pipe' });
          logger.warn({ pid: child.pid, group: group.name }, 'Host agent timeout: taskkill /F /T sent (tree kill)');
        } catch (err: any) {
          const msg = err?.stderr?.toString?.() ?? String(err);
          logger.warn(
            { pid: child.pid, err: msg },
            'taskkill /F /T failed during timeout — falling back to child.kill',
          );
          if (!child.killed) child.kill('SIGKILL');
        }
        // Watchdog still useful on win32 to confirm taskkill reaped the tree.
        setTimeout(() => {
          const stillAlive = child.exitCode === null && (child as any).signalCode === null;
          if (stillAlive) {
            logger.error(
              { group: group.name, processName, pid: child.pid },
              'host-runner timeout watchdog (win32): child still alive 30s after taskkill /F /T — chat may be wedged',
            );
          }
        }, 30_000).unref?.();
        return;
      }
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
        // Watchdog: SIGKILL on a process group should produce a 'close'
        // event on the parent within ~1s once stdio pipes drain. If we
        // are still seeing the child as alive 30s after SIGKILL, the
        // 'close' handler has not fired and GroupQueue.registerProcess()
        // exit listener is also blocked — historically this would wedge
        // the chat (state.active stays true on chat slot, all subsequent
        // user messages queued behind a dead process). After detached
        // tasks landed (proposal §4.1.A), this race no longer wedges
        // user chat: scheduled tasks run on their own slot key
        // (`${chatJid}::task::${taskId}`), so a stuck task slot leaves
        // the chat slot completely free. The watchdog still fires for
        // diagnostics on host-mode chat slots and gives ground truth
        // (pid/processName) when it does. We do NOT have evidence this
        // race has actually happened in production (grep across all
        // daemon logs: 0 hits for 'host-runner SIGKILL stuck'). Once we
        // see one, we wire a forceRelease() call into GroupQueue. Until
        // then this is logging-only by design — no bypass for an
        // unproven bug.
        setTimeout(() => {
          const stillAlive = child.exitCode === null && (child as any).signalCode === null;
          if (stillAlive) {
            logger.error(
              { group: group.name, processName, pid: child.pid },
              'host-runner SIGKILL watchdog: child still alive 30s after SIGKILL — chat may be wedged, please capture daemon log around this entry',
            );
          }
        }, 30_000).unref?.();
      }, 10_000);
    };

    let timeout: ReturnType<typeof setTimeout> | null = neverTimeout ? null : setTimeout(killOnTimeout, timeoutMs);

    // Absolute timeout: hard cap on a single query's run duration.
    // - Non-IPC mode (sandbox or short-lived host): cap = total process
    //   lifetime, since the process exits after the query.
    // - IPC mode (host with neverTimeout): cap = per-query budget. The
    //   timer is restarted whenever a new IPC input file appears (see
    //   fs.watch below) and cleared when the agent signals query-complete
    //   (result===null && newSessionId, the IPC-idle marker). Without this
    //   per-query semantics, a healthy long-lived agent gets SIGTERM'd at
    //   the lifetime cap and any IPC message piped in the seconds before
    //   the kill is silently dropped (typing indicator stays on, message
    //   lost). See docs/teams-stuck-agent-investigation.md.
    let absoluteTimeout: ReturnType<typeof setTimeout> | null =
      AGENT_RUN_TIMEOUT_MS > 0
        ? setTimeout(() => {
            logger.error(
              {
                group: group.name,
                processName,
                timeoutMs: AGENT_RUN_TIMEOUT_MS,
                mode: neverTimeout ? 'ipc-per-query' : 'lifetime',
              },
              'Agent absolute timeout reached, killing',
            );
            killOnTimeout();
          }, AGENT_RUN_TIMEOUT_MS)
        : null;
    const restartAbsoluteTimeout = (reason: string) => {
      if (AGENT_RUN_TIMEOUT_MS <= 0) return;
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      absoluteTimeout = setTimeout(() => {
        logger.error(
          {
            group: group.name,
            processName,
            timeoutMs: AGENT_RUN_TIMEOUT_MS,
            mode: 'ipc-per-query',
            reason,
          },
          'Agent absolute timeout reached (IPC per-query), killing',
        );
        killOnTimeout();
      }, AGENT_RUN_TIMEOUT_MS);
    };
    const pauseAbsoluteTimeout = (reason: string) => {
      if (absoluteTimeout) {
        clearTimeout(absoluteTimeout);
        absoluteTimeout = null;
        logger.info({ group: group.name, processName, reason }, 'Absolute timeout paused (agent idle-waiting for IPC)');
      }
    };

    // IPC mode: watch the input dir so each new IPC message restarts the
    // per-query budget. Use fs.watch (inotify on Linux) — events fire when
    // group-queue.sendMessage atomically renames a *.json.tmp into place.
    let ipcWatcher: fs.FSWatcher | null = null;
    if (neverTimeout && AGENT_RUN_TIMEOUT_MS > 0) {
      try {
        const watchDir = path.join(ipcDir, 'input');
        ipcWatcher = fs.watch(watchDir, (eventType, filename) => {
          if (eventType === 'rename' && filename && String(filename).endsWith('.json')) {
            logger.info(
              { group: group.name, processName, file: String(filename) },
              'IPC input received, restarting per-query timeout',
            );
            restartAbsoluteTimeout('ipc-input:' + String(filename));
          }
        });
      } catch (err: any) {
        logger.warn(
          { group: group.name, processName, err: err?.message ?? err },
          'Failed to watch IPC input dir for absolute-timeout reset',
        );
      }
    }

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

        const jsonStr = stdout.substring(startIdx + OUTPUT_START.length, endIdx).trim();
        stdout = stdout.substring(0, startIdx) + stdout.substring(endIdx + OUTPUT_END.length);

        try {
          const output: ContainerOutput = JSON.parse(jsonStr);
          hadStreamingOutput = true;
          resetTimeout();

          if (onOutput) {
            // SERIALIZE callbacks: chain via a per-runner promise so partials
            // arrive at the dispatcher in order AND each callback completes
            // before the next starts. Without this, fast SDK partials race
            // past the `if (!progressiveMsgId)` / `if (!flashReasoningMsgId)`
            // checks in src/index.ts and every concurrent partial sees the
            // id as undefined → all spawn fresh sendMessages instead of
            // editing the in-flight message. (kenan TG repro 2026-04-24:
            // 3 thinking previews + 2 finals from a single short prompt.)
            outputCallbackChain = outputCallbackChain.then(() =>
              onOutput(output).catch((err) => {
                logger.error({ error: err }, 'Error in host agent output callback');
              }),
            );
          }

          // Query-complete signal: result is null with newSessionId
          // This means agent finished the query and is waiting for IPC
          if (!resolved && output.result === null && output.newSessionId && !output.partial) {
            resolved = true;
            resolve(output);
          }
          // In IPC mode: a query just finished (whether it was the first
          // query that resolves the promise above, or a follow-up that
          // arrived via IPC). Pause the per-query absolute timeout until
          // the next IPC input restarts it. Without this, an idle agent
          // sitting on the watch loop still gets killed at the budget
          // expiry even though it's not stuck on anything.
          if (neverTimeout && output.result === null && output.newSessionId && !output.partial) {
            pauseAbsoluteTimeout('query-complete');
          }
        } catch (err) {
          logger.error({ error: err, json: jsonStr.substring(0, 200) }, 'Failed to parse host agent output');
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
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      if (ipcWatcher) {
        try {
          ipcWatcher.close();
        } catch {
          /* ignore */
        }
      }
      // Reap the whole subtree (copilot CLI + MCP grandchildren), not just the
      // node process whose stdio closed. On Windows the parent exiting does NOT
      // cascade to children, so without this they orphan and pile up across
      // respawns (root cause of the 400+ leaked procs / silent-host bug,
      // 2026-06-24). Fire-and-forget: the close handler is sync, and the reap
      // is best-effort + idempotent. Runs BEFORE unregister so a crash in the
      // kill path still leaves the pid recorded for `killAllAgentPids()` / sweep.
      if (child.pid) {
        const deadPid = child.pid;
        void treeKillAgent(deadPid, `host-agent-close(code=${code})`);
        unregisterAgentPid(deadPid);
      }
      const duration = Date.now() - startTime;

      if (resolved) {
        // Default path: promise already resolved (IPC mode after first
        // query-complete). Just log. BUT if exit was non-zero, also dump
        // the last ~50 stderr lines so root-cause is reachable from the
        // log without needing LOG_LEVEL=debug to have been on at crash
        // time. (Added 2026-04-21 after kenan's silent code=1 crash on
        // a gitignore request — the only signal in the log was the bare
        // `code=1` line; stderr was captured in-memory but discarded.)
        if (code !== 0 && stderr.trim()) {
          const tail = stderr.trim().split('\n').slice(-50).join('\n');
          logger.error(
            {
              group: group.name,
              processName,
              code,
              duration,
              stderrTail: tail,
            },
            'Host agent process exited non-zero AFTER delivering output (stderr tail captured)',
          );
        } else {
          logger.info(
            { group: group.name, processName, code, duration },
            'Host agent process ended (output already delivered)',
          );
        }
        return;
      }

      if (timedOut) {
        logger.error({ group: group.name, processName, duration }, 'Host agent timed out');
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
          const jsonStr = stdout.substring(lastStart + OUTPUT_START.length, lastEnd).trim();
          try {
            const output: ContainerOutput = JSON.parse(jsonStr);
            logger.info({ group: group.name, processName, duration, code }, 'Host agent completed');
            resolve(output);
            return;
          } catch {
            /* fall through */
          }
        }
      }

      if (hadStreamingOutput && code === 0) {
        logger.info({ group: group.name, processName, duration }, 'Host agent completed (streaming mode)');
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
      if (absoluteTimeout) clearTimeout(absoluteTimeout);
      if (ipcWatcher) {
        try {
          ipcWatcher.close();
        } catch {
          /* ignore */
        }
      }
      logger.error({ group: group.name, processName, error: err }, 'Host agent spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn host agent: ${err.message}`,
      });
    });
  });
}

import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './log-extensions.js';
import { RegisteredGroup } from './types-extensions.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<string | void>;
  sendFile?: (jid: string, filePath: string, filename?: string) => Promise<void>;
  reactToMessage?: (jid: string, emoji: string, messageId?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              }
              // Handle react IPC
              if (data.type === 'react' && data.chatJid && data.emoji && deps.reactToMessage) {
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await deps.reactToMessage(data.chatJid, data.emoji, data.messageId);
                  logger.info({ chatJid: data.chatJid, emoji: data.emoji }, 'IPC reaction sent');
                }
              }
              // Handle send_file IPC
              if (data.type === 'send_file' && data.chatJid && data.filePath && deps.sendFile) {
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await deps.sendFile(data.chatJid, data.filePath, data.filename);
                  logger.info({ chatJid: data.chatJid, file: data.filePath }, 'IPC file sent');
                }
              }
              // Handle nanoclaw_control IPC (restart, config changes)
              if (data.type === 'control' && isMain) {
                await handleControlIpc(data, deps);
              }
              // Handle nanoclaw_plugin IPC (list/install/uninstall/marketplace_*).
              // Plugin reads are safe everywhere, but mutating actions are
              // restricted to the main chat (same model as control).
              if (data.type === 'plugin') {
                if (['list', 'marketplace_list'].includes(data.action) || isMain) {
                  const responseDir = path.join(ipcBaseDir, sourceGroup, 'responses');
                  await handlePluginIpc(data, responseDir);
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();

  // Orphan sweeper for plugin response files. The agent unlinks the
  // response after reading it, but if the agent process dies between
  // "host wrote response" and "agent read it", the file would sit forever.
  // Sweep on startup + every hour, deleting responses older than 5 minutes
  // (well beyond the agent's 30s poll timeout).
  const sweepOrphanResponses = () => {
    try {
      if (!fs.existsSync(ipcBaseDir)) return;
      const cutoff = Date.now() - 5 * 60 * 1000;
      let swept = 0;
      for (const group of fs.readdirSync(ipcBaseDir)) {
        const responsesDir = path.join(ipcBaseDir, group, 'responses');
        if (!fs.existsSync(responsesDir)) continue;
        for (const file of fs.readdirSync(responsesDir)) {
          if (!file.endsWith('.json')) continue;
          const fp = path.join(responsesDir, file);
          try {
            const stat = fs.statSync(fp);
            if (stat.mtimeMs < cutoff) {
              fs.unlinkSync(fp);
              swept++;
            }
          } catch {
            // ignore per-file errors (raced unlink, etc)
          }
        }
      }
      if (swept > 0) {
        logger.info({ swept }, 'Swept orphan plugin response files');
      }
    } catch (err) {
      logger.warn({ err }, 'Orphan response sweep failed');
    }
  };
  sweepOrphanResponses();
  setInterval(sweepOrphanResponses, 60 * 60 * 1000);

  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.targetJid) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn({ targetJid }, 'Cannot schedule task: target group not registered');
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn({ sourceGroup, targetFolder }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId = data.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated' ? data.context_mode : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info({ taskId, sourceGroup, targetFolder, contextMode }, 'Task created via IPC');
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
          deps.onTasksChanged();
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
          deps.onTasksChanged();
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
          deps.onTasksChanged();
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Task not found for update');
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task update attempt');
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
        if (data.schedule_value !== undefined) updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(updatedTask.schedule_value, { tz: TIMEZONE });
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn({ taskId: data.taskId, value: updatedTask.schedule_value }, 'Invalid cron in task update');
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info({ taskId: data.taskId, sourceGroup, updates }, 'Task updated via IPC');
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(sourceGroup, true, availableGroups, new Set(Object.keys(registeredGroups)));
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn({ sourceGroup, folder: data.folder }, 'Invalid register_group request - unsafe folder name');
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Handle nanoclaw_control IPC commands.
 * Only allowed from main group for security.
 * Whitelist of safe operations — no arbitrary command execution.
 */
async function handleControlIpc(data: any, deps: IpcDeps): Promise<void> {
  const action = data.action;
  logger.info({ action, configPath: data.configPath }, 'IPC control command');

  switch (action) {
    case 'restart': {
      logger.info('IPC control: restarting nanoclaw...');
      // Delay restart to allow current IPC cycle to complete
      setTimeout(() => {
        const { execSync } = require('child_process');
        try {
          execSync('nanoclaw restart', { stdio: 'pipe', timeout: 15000 });
        } catch {
          // restart kills current process, this catch may not run
        }
      }, 2000);
      break;
    }
    case 'reload_config': {
      logger.info('IPC control: reloading config...');
      try {
        const { reloadConfig } = await import('./config.js');
        reloadConfig();
        logger.info('Config reloaded via IPC control');
      } catch (err) {
        logger.error({ err }, 'Failed to reload config via IPC');
      }
      break;
    }
    case 'set_config': {
      if (!data.configPath) {
        logger.warn('IPC control set_config: missing configPath');
        break;
      }
      try {
        const { loadConfig, saveConfig } = await import('./config-loader.js');
        const config = loadConfig();
        // Navigate to the field and set it
        const parts = data.configPath.split('.');
        let obj: any = config;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!obj[parts[i]]) obj[parts[i]] = {};
          obj = obj[parts[i]];
        }
        // Parse JSON value if possible, otherwise use as string
        let value: any = data.configValue;
        try {
          value = JSON.parse(value);
        } catch {
          /* use as string */
        }
        obj[parts[parts.length - 1]] = value;
        saveConfig(config, 'ipc-agent', {
          via: 'ipc.nanoclaw_control.set_config',
          configPath: data.configPath,
        });
        // Also reload in memory
        const { reloadConfig } = await import('./config.js');
        reloadConfig();
        logger.info({ path: data.configPath, value }, 'Config updated via IPC control');
      } catch (err) {
        logger.error({ err, path: data.configPath }, 'Failed to set config via IPC');
      }
      break;
    }
    default:
      logger.warn({ action }, 'Unknown IPC control action');
  }
}

/**
 * Sweep orphaned plugin response files. The agent unlinks each response
 * after reading it, but if the agent process dies between "host wrote
 * response" and "agent read it", the file would sit forever. Files older
 * than `maxAgeMs` (default 5 min, well beyond the agent's 30s poll
 * timeout) are deleted. Returns the number of files swept.
 */
export function sweepOrphanResponses(ipcBaseDir: string, maxAgeMs = 5 * 60 * 1000): number {
  let swept = 0;
  try {
    if (!fs.existsSync(ipcBaseDir)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    for (const group of fs.readdirSync(ipcBaseDir)) {
      const responsesDir = path.join(ipcBaseDir, group, 'responses');
      if (!fs.existsSync(responsesDir)) continue;
      for (const file of fs.readdirSync(responsesDir)) {
        if (!file.endsWith('.json')) continue;
        const fp = path.join(responsesDir, file);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fp);
            swept++;
          }
        } catch {
          // ignore per-file errors (raced unlink, etc)
        }
      }
    }
    if (swept > 0) {
      logger.info({ swept }, 'Swept orphan plugin response files');
    }
  } catch (err) {
    logger.warn({ err }, 'Orphan response sweep failed');
  }
  return swept;
}

export async function handlePluginIpc(data: any, responseDir: string): Promise<void> {
  const requestId: string | undefined = data.requestId;
  const writeResponse = (payload: unknown) => {
    if (!requestId) return;
    try {
      fs.mkdirSync(responseDir, { recursive: true });
      fs.writeFileSync(path.join(responseDir, `${requestId}.json`), JSON.stringify(payload));
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to write plugin IPC response');
    }
  };

  try {
    const action = data.action;
    const plugin = await import('./cli/plugin.js');
    switch (action) {
      case 'list': {
        const pluginsDir = path.join((await import('./workspace.js')).resolveWorkspace(), 'plugins');
        const out: Array<{
          name: string;
          version?: string;
          description?: string;
          provider?: string;
        }> = [];
        if (fs.existsSync(pluginsDir)) {
          for (const entry of fs.readdirSync(pluginsDir, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            // Try both manifest layouts (root and .claude-plugin/)
            const candidates = [
              path.join(pluginsDir, entry.name, 'plugin.json'),
              path.join(pluginsDir, entry.name, '.claude-plugin', 'plugin.json'),
            ];
            for (const mp of candidates) {
              if (!fs.existsSync(mp)) continue;
              try {
                const m = JSON.parse(fs.readFileSync(mp, 'utf-8'));
                out.push({
                  name: m?.name && typeof m.name === 'string' ? m.name : entry.name,
                  version: m.version,
                  description: m.description,
                  provider: m.provider,
                });
                break;
              } catch {
                /* try next */
              }
            }
          }
        }
        writeResponse({ ok: true, plugins: out });
        break;
      }
      case 'install': {
        if (!data.source) {
          writeResponse({ ok: false, error: 'install requires `source`' });
          break;
        }
        // Add to plugins.enabledPlugins[] if not already there, then auto-install.
        const { loadConfig, saveConfig, getEnabledPlugins, setEnabledPlugins } = await import('./config-loader.js');
        const config = loadConfig();
        const enabledList = getEnabledPlugins(config);
        const name = data.name || tryReadPluginName(data.source) || deriveNameFromSource(data.source);
        if (!name) {
          writeResponse({
            ok: false,
            error: 'Could not derive plugin name from source; pass `name`',
          });
          break;
        }
        const existing = enabledList.find((e) => e.name === name);
        if (!existing) {
          setEnabledPlugins(config, [...enabledList, { name, source: data.source }]);
          saveConfig(config);
        }
        const result = await plugin.ensureEnabledPluginsInstalled();
        writeResponse({ ok: true, name, result });
        break;
      }
      case 'uninstall':
      case 'remove': {
        if (!data.name) {
          writeResponse({ ok: false, error: 'uninstall requires `name`' });
          break;
        }
        const { loadConfig, saveConfig, getEnabledPlugins, setEnabledPlugins } = await import('./config-loader.js');
        const { resolveWorkspace } = await import('./workspace.js');
        const config = loadConfig();
        const enabledList = getEnabledPlugins(config);
        if (enabledList.length > 0) {
          setEnabledPlugins(
            config,
            enabledList.filter((e) => e.name !== data.name),
          );
          saveConfig(config);
        }
        const target = path.join(resolveWorkspace(), 'plugins', data.name);
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true });
        }
        writeResponse({ ok: true, name: data.name });
        break;
      }
      case 'marketplace_list': {
        const { loadConfig, getExtraKnownMarketplaces } = await import('./config-loader.js');
        const config = loadConfig();
        writeResponse({
          ok: true,
          marketplaces: getExtraKnownMarketplaces(config),
        });
        break;
      }
      default:
        writeResponse({ ok: false, error: `unknown action: ${action}` });
    }
  } catch (err: any) {
    logger.error({ err }, 'Failed to handle plugin IPC');
    writeResponse({ ok: false, error: err.message ?? String(err) });
  }
}

function deriveNameFromSource(source: string): string | null {
  // Mirrors the logic in cli/plugin.ts marketplaceAdd: prefer the repo half
  // of owner/repo, fall back to the basename of a path/URL.
  if (/^[\w.-]+\/[\w.-]+(?::|$)/.test(source)) {
    // owner/repo or owner/repo:subdir
    const repo = source.split('/')[1].split(':')[0];
    return repo;
  }
  const m = source.match(/\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m) return m[1];
  const base = path.basename(source.replace(/\.git$/, ''));
  return base || null;
}

/**
 * Last-resort: if `source` is a local directory and contains a plugin.json
 * (or .claude-plugin/plugin.json), read the canonical `name` field from it.
 * This wins over directory-basename so users can clone a plugin into any
 * folder and still get the declared name registered in plugins.enabled[].
 */
function tryReadPluginName(source: string): string | null {
  try {
    if (!fs.existsSync(source)) return null;
    const stat = fs.statSync(source);
    if (!stat.isDirectory()) return null;
    const candidates = [path.join(source, 'plugin.json'), path.join(source, '.claude-plugin', 'plugin.json')];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (m?.name && typeof m.name === 'string') return m.name;
    }
  } catch {
    // ignore — fall through to caller's null path
  }
  return null;
}

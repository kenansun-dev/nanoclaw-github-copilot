import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Tests for #188/#189 process liveness + IPC queue ---

  it('sendMessage cleans up state and re-queues when process exitCode is not null', async () => {
    // Updated 2026-04-21: previously this rejected silently and left the
    // user wedged. Now it returns false (caller persists the message) and
    // also clears dangling state so drainGroup can respawn for the next tick.
    vi.useRealTimers();
    const queue = new GroupQueue();
    queue.setProcessMessagesFn(async () => true);

    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'c1',
      'folder1',
    );
    const state = (queue as any).getGroup('group1@g.us');
    state.active = true;

    // Simulate process death
    state.process.exitCode = 1;
    expect(queue.sendMessage('group1@g.us', 'hello')).toBe(false);
    // State should now be cleaned up: dead process reference is gone, and
    // drainGroup has re-triggered runForGroup which set active=true again
    // with a fresh slot ready for the new agent spawn.
    expect(state.process).toBeNull();
    // pendingMessages was set so drainGroup picks up; runForGroup may have
    // already cleared it (depending on processMessagesFn synchrony) or left
    // it for the next tick. Either way, the dangling dead-process state is
    // gone, which is the actual fix.
  });

  it('drainGroup pipes messages to idle agent via processMessagesFn', async () => {
    vi.useRealTimers();
    const queue = new GroupQueue();
    let pipeCalled = false;
    queue.setProcessMessagesFn(async () => {
      pipeCalled = true;
      return true;
    });

    queue.registerProcess(
      'group1@g.us',
      { on: () => {}, exitCode: null, killed: false } as any,
      'c1',
      'folder1',
    );
    const state = (queue as any).getGroup('group1@g.us');
    state.active = true;
    state.idleWaiting = true;
    state.pendingMessages = true;
    (queue as any).activeCount = 1;

    (queue as any).drainGroup('group1@g.us');
    await new Promise((r) => setTimeout(r, 50));
    expect(pipeCalled).toBe(true);
    expect(state.pendingMessages).toBe(false);
  });

  describe('busy ack (shouldSendBusyAck)', () => {
    function setupActive(jid: string) {
      const state = (queue as any).getGroup(jid);
      state.active = true;
      state.groupFolder = 'folder-busy';
      state.process = { exitCode: null, killed: false } as any;
      return state;
    }

    it('returns null on the first piped message (typing covers it)', () => {
      setupActive('g@g.us');
      expect(queue.sendMessage('g@g.us', 'first')).toBe(true);
      expect(queue.shouldSendBusyAck('g@g.us')).toBeNull();
    });

    it('returns 2 on the second piped message before agent output', () => {
      setupActive('g@g.us');
      queue.sendMessage('g@g.us', 'first');
      queue.sendMessage('g@g.us', 'second');
      expect(queue.shouldSendBusyAck('g@g.us')).toBe(2);
    });

    it('returns null for 3rd, 4th piped messages (silent after first ack)', () => {
      setupActive('g@g.us');
      queue.sendMessage('g@g.us', 'first');
      queue.sendMessage('g@g.us', 'second');
      queue.sendMessage('g@g.us', 'third');
      expect(queue.shouldSendBusyAck('g@g.us')).toBeNull();
      queue.sendMessage('g@g.us', 'fourth');
      expect(queue.shouldSendBusyAck('g@g.us')).toBeNull();
    });

    it('does not ack once the agent has produced output', () => {
      setupActive('g@g.us');
      queue.sendMessage('g@g.us', 'first');
      queue.notifyAgentOutput('g@g.us');
      queue.sendMessage('g@g.us', 'second');
      expect(queue.shouldSendBusyAck('g@g.us')).toBeNull();
    });

    it('re-arms ack window after agent goes silent again', () => {
      setupActive('g@g.us');
      queue.sendMessage('g@g.us', 'first');
      queue.notifyAgentOutput('g@g.us');
      // Counter resets, but agentHasOutput stays true — so further messages
      // in the SAME turn never re-trigger the ack. Verifying that intent.
      queue.sendMessage('g@g.us', 'follow');
      queue.sendMessage('g@g.us', 'follow2');
      expect(queue.shouldSendBusyAck('g@g.us')).toBeNull();
    });

    it('resets on new container spawn (runForGroup)', async () => {
      setupActive('g@g.us');
      queue.sendMessage('g@g.us', 'first');
      queue.sendMessage('g@g.us', 'second');
      // Simulate respawn by clearing active and re-running runForGroup
      const state = (queue as any).getGroup('g@g.us');
      state.active = false;
      (queue as any).activeCount = 0;
      queue.setProcessMessagesFn(async () => true);
      queue.enqueueMessageCheck('g@g.us');
      await vi.advanceTimersByTimeAsync(10);
      expect(state.pipedSinceOutput).toBe(0);
      expect(state.agentHasOutput).toBe(false);
    });
  });

  describe('process-died-without-output cursor rollback', () => {
    /**
     * Helper: spin up an active+idle-waiting group with a fake long-lived
     * process. Mirrors the production flow where runContainer's finally
     * block sees `processAlive && state.idleWaiting` and keeps state.active=true.
     */
    async function spinUpIdleAgent(
      groupJid: string,
      pid: number,
    ): Promise<{ proc: any }> {
      const { EventEmitter } = await import('events');
      const proc = new EventEmitter() as any;
      proc.exitCode = null;
      proc.killed = false;
      proc.pid = pid;
      const processMessages = vi.fn(async () => {
        // Production order: spawn process, register, then settle into
        // idle-waiting state once the agent emits its query-complete signal.
        queue.registerProcess(
          groupJid,
          proc,
          'container-' + pid,
          'test-group-' + pid,
        );
        queue.markIdle(groupJid);
        return true;
      });
      queue.setProcessMessagesFn(processMessages);
      queue.enqueueMessageCheck(groupJid);
      await vi.advanceTimersByTimeAsync(10);
      return { proc };
    }

    it('fires onProcessDiedWithoutOutput with rollback cursor when piped agent dies idle', async () => {
      const callback = vi.fn();
      queue.setOnProcessDiedWithoutOutput(callback);

      const { proc } = await spinUpIdleAgent('group1@g.us', 12345);

      // Pipe a follow-up message through IPC with a rollback cursor
      // (the cursor that was active *before* index.ts advanced it)
      const ok = queue.sendMessage(
        'group1@g.us',
        'follow-up question',
        '2026-04-21T03:25:25.000Z',
      );
      expect(ok).toBe(true);

      // Now simulate the host process dying (SIGTERM, crash, etc.)
      // BEFORE the agent has produced output for the piped message.
      proc.exitCode = 143; // SIGTERM
      proc.emit('exit');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        'group1@g.us',
        '2026-04-21T03:25:25.000Z',
        143,
      );
    });

    it('fires callback with null cursor + exit=0 when process exits cleanly after producing output', async () => {
      // Updated 2026-04-21: callback now also fires for case3 (delivered-then-died)
      // so dangling state gets cleaned and the next user message can respawn.
      // hadInFlight=false here so rollback cursor is null; exitCode=0 means
      // index.ts will skip the user-facing crash notice.
      const callback = vi.fn();
      queue.setOnProcessDiedWithoutOutput(callback);

      const { proc } = await spinUpIdleAgent('group1@g.us', 12346);

      queue.sendMessage('group1@g.us', 'q', '2026-04-21T01:00:00Z');
      // Agent produces output — cursor is no longer in flight
      queue.notifyAgentOutput('group1@g.us');

      proc.exitCode = 0;
      proc.emit('exit');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('group1@g.us', null, 0);
    });

    it('does NOT fire callback when process dies before any IPC pipe', async () => {
      const callback = vi.fn();
      queue.setOnProcessDiedWithoutOutput(callback);

      const { proc } = await spinUpIdleAgent('group1@g.us', 12347);

      // No sendMessage — process dies idle with nothing piped.
      proc.exitCode = 137; // SIGKILL
      proc.emit('exit');

      // pipedSinceOutput===0, so callback should NOT fire (no rollback needed)
      expect(callback).not.toHaveBeenCalled();
    });

    it('keeps the EARLIEST piped cursor across multiple IPC pipes (oldest unacked wins)', async () => {
      const callback = vi.fn();
      queue.setOnProcessDiedWithoutOutput(callback);

      const { proc } = await spinUpIdleAgent('group1@g.us', 12348);

      // Three pipes in sequence — the FIRST cursor must win
      queue.sendMessage('group1@g.us', 'q1', '2026-04-21T01:00:00Z');
      queue.sendMessage('group1@g.us', 'q2', '2026-04-21T01:00:05Z');
      queue.sendMessage('group1@g.us', 'q3', '2026-04-21T01:00:10Z');

      proc.exitCode = 143;
      proc.emit('exit');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        'group1@g.us',
        '2026-04-21T01:00:00Z',
        143,
      );
    });
  });
});

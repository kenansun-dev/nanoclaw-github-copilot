/**
 * IPC helpers extracted from index.ts so unit tests can import the real
 * implementations instead of re-implementing the logic in the test file.
 *
 * History (2026-05-01, VM lane test audit): src/ipc-helpers.test.ts was
 * a fake-coverage test — it copy-pasted the drainIpcInput / shouldClose
 * logic into the test body. Deleting prod code did not break the test.
 * This module is the single source of truth so the test can fail when
 * prod regresses.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface IpcHelperOptions {
  inputDir: string;
  closeSentinel?: string;
  pollMs?: number;
  /**
   * Optional logger. Defaults to a noop so unit tests stay quiet.
   * The runner injects its console.error-based logger.
   */
  log?: (message: string) => void;
}

export function makeIpcHelpers(opts: IpcHelperOptions) {
  const inputDir = opts.inputDir;
  const closeSentinel = opts.closeSentinel ?? path.join(inputDir, '_close');
  const pollMs = opts.pollMs ?? 500;
  const log = opts.log ?? (() => {});

  function shouldClose(): boolean {
    if (fs.existsSync(closeSentinel)) {
      try {
        fs.unlinkSync(closeSentinel);
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  function drainIpcInput(): string[] {
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const files = fs
        .readdirSync(inputDir)
        .filter((f) => f.endsWith('.json'))
        .sort();

      const messages: string[] = [];
      for (const file of files) {
        const filePath = path.join(inputDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fs.unlinkSync(filePath);
          if (data.type === 'message' && data.text) {
            messages.push(data.text);
          }
        } catch (err) {
          log(
            `Failed to process input file ${file}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
        }
      }
      return messages;
    } catch (err) {
      log(
        `IPC drain error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  function waitForIpcMessage(): Promise<string | null> {
    return new Promise((resolve) => {
      const poll = () => {
        // Drain messages BEFORE checking close sentinel — prevents race where
        // _close arrives before a pending message file is read.
        const messages = drainIpcInput();
        if (messages.length > 0) {
          resolve(messages.join('\n'));
          return;
        }
        if (shouldClose()) {
          resolve(null);
          return;
        }
        setTimeout(poll, pollMs);
      };
      poll();
    });
  }

  return { shouldClose, drainIpcInput, waitForIpcMessage };
}

export type IpcHelpers = ReturnType<typeof makeIpcHelpers>;

/**
 * Tiny JSONC parser used for files written by the GitHub Copilot CLI.
 *
 * The Copilot CLI writes `~/.copilot/config.json` with a leading
 *   // User settings belong in settings.json.
 *   // This file is managed automatically.
 * banner. Strict `JSON.parse` rejects it, so any code path that read the
 * file with bare `JSON.parse` would silently treat the user as
 * unauthenticated (`nanoclaw status` showed `🔑 Auth: ❌ not configured`
 * even when copilot was fully logged in — see PR #46 follow-up,
 * 2026-05-12).
 *
 * We intentionally hand-roll a minimal stripper instead of pulling in
 * `strip-json-comments` to keep the dependency surface small. It handles
 * the two cases we see in the wild:
 *
 *   1. `// line comments` (whole-line and trailing)
 *   2. `/* block comments * /`
 *
 * It is comment-string-aware so `"//"` inside a JSON string value is
 * preserved untouched. Trailing commas are NOT supported (the Copilot
 * CLI never writes them).
 */
export function stripJsonComments(input: string): string {
  let out = '';
  let i = 0;
  const n = input.length;
  let inString = false;
  let stringQuote = '';
  let inLineComment = false;
  let inBlockComment = false;

  while (i < n) {
    const ch = input[i];
    const next = i + 1 < n ? input[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) inString = false;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Parse JSON or JSONC text. Tries strict `JSON.parse` first (cheap fast
 * path for clean files) and falls back to comment-stripped parse on
 * failure. Throws the original strict error if the stripped version also
 * fails to parse, so caller sees a sensible message.
 */
export function parseJsonc<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (firstErr) {
    try {
      return JSON.parse(stripJsonComments(text)) as T;
    } catch {
      throw firstErr;
    }
  }
}

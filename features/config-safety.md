# Config Safety

## Status: CRITICAL — needs immediate fix

## Problem

When `nanoclaw.json` has a JSON syntax error (e.g. user typo), nanoclaw's config loader fails to parse it and **overwrites the file with default empty config**, destroying all user settings.

This happened to Kenan — one malformed JSON edit wiped his entire configuration including channel credentials, agent settings, and chat registrations.

## Expected Behavior

If `nanoclaw.json` is malformed:
1. **Never overwrite** the existing file
2. Log the parse error with line/column information
3. Refuse to start (or start with last known good config)
4. Tell the user exactly what's wrong and where

## Proposed Solution

### Phase 1: Immediate fix — never overwrite on parse error

```typescript
function loadConfig(): NanoclawConfig {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return mergeWithDefaults(config);
  } catch (err) {
    if (err instanceof SyntaxError) {
      // NEVER overwrite — log error and exit
      logger.fatal({
        file: configPath,
        error: err.message,
      }, 'Config file has invalid JSON. Fix the error and restart.');
      process.exit(1);
    }
    throw err;
  }
}
```

### Phase 2: Config backup on every successful load

Before applying any config changes (migration, saveConfig), back up the current valid config:

```
~/.nanoclaw/config-backups/
├── nanoclaw.json.2026-04-15T22-30-00.bak
├── nanoclaw.json.2026-04-14T18-00-00.bak
└── ...  (keep last 10)
```

### Phase 3: Config validation before write

Any code path that writes `nanoclaw.json` should:
1. Parse the new JSON to verify it's valid
2. Compare with current config — warn if critical fields are being removed
3. Write to a temp file first, then atomic rename

### Phase 4: `nanoclaw config validate`

CLI command to check config without starting:

```bash
nanoclaw config validate
# ✅ Config valid (23 fields, 3 channels, 5 chats)
# or
# ❌ Config invalid: Unexpected token } at line 42, column 3
```

## Where the bug is

The bug is likely in `config-loader.ts` — when `loadConfig()` catches a parse error, it might call `saveConfig(defaults)` which overwrites the file. Or `nanoclaw init` runs on startup and recreates the file from defaults when parsing fails.

## Root Cause Analysis Needed

- Find the exact code path that overwrites config on parse error
- Add regression test: write invalid JSON → loadConfig → verify file unchanged

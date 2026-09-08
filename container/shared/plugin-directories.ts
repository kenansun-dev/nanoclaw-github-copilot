import fs from 'fs';
import path from 'path';

/** SDK 1.0.13 plugins.builtin.set is a replacement set with maxItems: 64. */
const MAX_BUILTIN_PLUGIN_DIRECTORIES = 64;

/** Resolve once so native registration and the custom-agent fallback agree. */
export function resolvePluginDirectories(
  raw: string | undefined,
  onWarn: (message: string) => void,
): { pluginDirs: string[]; builtinPluginDirectories: string[] } {
  const pluginDirs = [
    ...new Set(
      (raw ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.resolve(dir)),
    ),
  ].filter((dir) => fs.existsSync(dir));
  const builtinPluginDirectories = pluginDirs.slice(0, MAX_BUILTIN_PLUGIN_DIRECTORIES);
  const skipped = pluginDirs.slice(MAX_BUILTIN_PLUGIN_DIRECTORIES);
  if (skipped.length > 0) {
    onWarn(
      `WARNING: ${pluginDirs.length} unique plugin directories; Copilot SDK supports at most ${MAX_BUILTIN_PLUGIN_DIRECTORIES}. ` +
        `Native plugin features are not loaded for ${skipped.length} skipped directory(s): ${JSON.stringify(skipped)}. ` +
        'Custom-agent fallback still scans all directories. Reduce NANOCLAW_PLUGIN_DIRS (or the discovered plugin set) to 64 or fewer to load all native plugin features; order determines the first 64.',
    );
  }
  return { pluginDirs, builtinPluginDirectories };
}

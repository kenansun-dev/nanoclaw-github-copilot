/**
 * nanoclaw config set — update a value in nanoclaw.json
 */

import fs from 'fs';
import { paths } from '../workspace.js';
import { logger } from '../logger.js';

/**
 * Set a nested config value by dot-separated key path.
 * Writes back to nanoclaw.json.
 */
export function configSet(key: string, value: string): void {
  const configPath = paths.config;

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found: ${configPath}. Run "nanoclaw init" first.`,
    );
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const parts = key.split('.');

  // Navigate to parent, create intermediate objects if needed
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] === undefined) {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]];
  }

  const lastKey = parts[parts.length - 1];

  // Try to parse value as JSON (for booleans, numbers, objects)
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value; // treat as string
  }

  obj[lastKey] = parsed;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  logger.info({ key, value: parsed }, 'Config updated');
}

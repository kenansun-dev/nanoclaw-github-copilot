/**
 * Memory tools — per-group MEMORY.md + daily journals.
 *
 * Wraps `../memory-tools.ts` (source of truth, kept untouched so the
 * shared/reference flow that build-time copies it stays intact). This
 * module exists so the barrel `./index.ts` only needs side-effect
 * imports, matching upstream's `mcp-tools/` layout.
 */
import { registerMemoryTools } from '../memory-tools.js';
import { getServer } from './server.js';

registerMemoryTools(getServer() as any);

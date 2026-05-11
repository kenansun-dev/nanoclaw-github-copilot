#!/usr/bin/env node
// Strip sourcemaps + .d.ts.map files from dist/ before npm pack.
//
// Sourcemaps + declarationMaps roughly double the unpacked tgz size and
// are not needed by end-users (devs always have the full repo). Tsconfig
// keeps maps on for local dev/debugging; we only nuke them for the
// published tarball. Maps are gitignored, so deleting them does not dirty
// the worktree, and the next `npm run build` regenerates them.
//
// Runs as part of `npm pack` (via `prepack`) so any tgz produced is slim.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const MAP_ROOTS = ['dist', 'container/agent-runner/dist', 'container/agent-runner-ghc/dist'];

let removed = 0;
let bytesFreed = 0;

function walk(dir, predicate) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing dir is fine (e.g. runner dist not built yet)
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, predicate);
    } else if (e.isFile() && predicate(full)) {
      const sz = statSync(full).size;
      unlinkSync(full);
      removed++;
      bytesFreed += sz;
    }
  }
}

for (const root of MAP_ROOTS) {
  walk(root, (p) => p.endsWith('.map') || p.endsWith('.d.ts.map'));
}

const kb = (bytesFreed / 1024).toFixed(1);
console.log(`[strip-sourcemaps] removed ${removed} files (${kb} KB)`);

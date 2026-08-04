// Copies the Teams relay proto into dist/proto so the south-edge gRPC client
// (@grpc/proto-loader) can resolve it at runtime from the installed package.
// Kept dependency-free + idempotent; runs as a postbuild step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'proto', 'teams_relay.proto');
const destDir = path.join(root, 'dist', 'proto');
const dest = path.join(destDir, 'teams_relay.proto');

if (!fs.existsSync(src)) {
  console.error(`[copy-proto] source proto not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[copy-proto] ${path.relative(root, src)} -> ${path.relative(root, dest)}`);

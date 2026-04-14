/**
 * Teams App Manifest packaging.
 *
 * Generates manifest.json + icons, packages into a zip for sideloading.
 */

import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';
import { paths } from '../workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate a simple solid-color PNG image.
 * Returns a Buffer with a valid PNG file.
 */
function generatePng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Buffer {
  // Minimal PNG: IHDR + IDAT (uncompressed) + IEND

  // Raw image data: filter byte (0) + RGB pixels per row
  const rawRows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // no filter
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);
  const compressed = deflateSync(rawData);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([typeBytes, data]);

    // CRC32 computation
    let crc = crc32Compute(body);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  }

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT
  const idat = makeChunk('IDAT', compressed);

  // IEND
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Simple CRC32 implementation for PNG chunks.
 */
function crc32Compute(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xedb88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Create a zip file from a list of {name, data} entries.
 * Minimal zip implementation — no compression (STORED), sufficient for manifests.
 */
function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf-8');

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression (STORED)
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    const crc = crc32Compute(entry.data);
    local.writeUInt32LE(crc, 14); // crc32
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // compression
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16); // crc32
    central.writeUInt32LE(entry.data.length, 20); // compressed
    central.writeUInt32LE(entry.data.length, 24); // uncompressed
    central.writeUInt16LE(nameBytes.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    localHeaders.push(Buffer.concat([local, entry.data]));
    centralHeaders.push(central);
    offset += local.length + entry.data.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralHeaders);
  const centralDirSize = centralDir.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

/**
 * Generate Teams App manifest zip.
 *
 * @param appId - Azure AD App Registration ID
 * @param botName - Bot display name
 * @returns Path to the generated zip file
 */
export async function setupManifest(
  appId: string,
  botName: string,
): Promise<string> {
  console.log('\n📄 Generating Teams App manifest...');

  const manifest = {
    $schema:
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: '1.0.0',
    id: appId,
    developer: {
      name: 'NanoClaw',
      websiteUrl: 'https://github.com/kenans/nanoclaw-github-copilot',
      privacyUrl: 'https://github.com/kenans/nanoclaw-github-copilot',
      termsOfUseUrl: 'https://github.com/kenans/nanoclaw-github-copilot',
    },
    name: { short: botName, full: `${botName} AI Assistant` },
    description: {
      short: 'AI Assistant powered by NanoClaw',
      full: 'NanoClaw AI Assistant - runs agents securely.',
    },
    icons: { outline: 'outline.png', color: 'color.png' },
    accentColor: '#4F46E5',
    bots: [
      {
        botId: appId,
        scopes: ['personal', 'team', 'groupChat'],
        supportsFiles: true,
        isNotificationOnly: false,
        commandLists: [
          {
            scopes: ['personal'],
            commands: [
              {
                title: '/chatid',
                description: 'Get this chat registration ID',
              },
              { title: '/ping', description: 'Check if bot is online' },
              { title: '/new', description: 'Start a new conversation' },
              { title: '/status', description: 'Show system status' },
              {
                title: '/think',
                description: 'Set thinking level (low/medium/high/xhigh)',
              },
              {
                title: '/reasoning',
                description: 'Show or hide reasoning output (on/off)',
              },
              { title: '/tasks', description: 'List scheduled tasks' },
              {
                title: '/capabilities',
                description: 'Show available tools and skills',
              },
              { title: '/help', description: 'Show available commands' },
              {
                title: '/wiki',
                description: 'Knowledge base — ingest, query, or maintain',
              },
            ],
          },
        ],
      },
    ],
  };

  // Icons: use custom icons from workspace if available, otherwise generate placeholders
  const wsPaths = paths;
  // Icons priority: ~/.nanoclaw/ custom > bundled nanoclaw icon > generated placeholder
  const wsCfgDir = path.dirname(wsPaths.config);
  const customColorIcon = path.join(wsCfgDir, 'teams-color.png');
  const customOutlineIcon = path.join(wsCfgDir, 'teams-outline.png');
  const bundledIcon = path.join(
    __dirname,
    '..',
    '..',
    'container',
    'assets',
    'teams-color-icon.png',
  );
  const colorIcon = fs.existsSync(customColorIcon)
    ? fs.readFileSync(customColorIcon)
    : fs.existsSync(bundledIcon)
      ? fs.readFileSync(bundledIcon)
      : generatePng(192, 192, 79, 70, 229);
  const outlineIcon = fs.existsSync(customOutlineIcon)
    ? fs.readFileSync(customOutlineIcon)
    : generatePng(32, 32, 255, 255, 255);

  const manifestJson = JSON.stringify(manifest, null, 2);

  // Create zip
  const zipBuffer = createZip([
    { name: 'manifest.json', data: Buffer.from(manifestJson) },
    { name: 'color.png', data: colorIcon },
    { name: 'outline.png', data: outlineIcon },
  ]);

  // Write to ~/.nanoclaw/teams-manifest.zip
  const wsDir = path.dirname(paths.config);
  const zipPath = path.join(wsDir, 'teams-manifest.zip');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(zipPath, zipBuffer);

  console.log(`  ✅ Manifest: ${zipPath}`);
  console.log('');
  console.log('  To sideload in Teams:');
  console.log(
    '    1. Open Teams → Apps → Manage your apps → Upload a custom app',
  );
  console.log(`    2. Select ${zipPath}`);
  console.log('    3. Add the bot to a chat or team');
  console.log('');

  return zipPath;
}

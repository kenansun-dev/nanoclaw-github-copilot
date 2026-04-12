/**
 * PDF MCP Server for NanoClaw
 *
 * Provides read_pdf tool for extracting text from PDF files.
 * Uses pdf-parse (pure JS, cross-platform — works on Windows/Linux/Mac).
 *
 * Registered as a local MCP server in agent-runner session config.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

import { PDFParse } from 'pdf-parse';

async function parsePdf(filePath: string): Promise<{ text: string; numpages: number; pages: Array<{num: number; text: string}>; info: any }> {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const textResult = await parser.getText();
  let info: any = {};
  try {
    const infoResult = await parser.getInfo();
    info = infoResult.info ?? {};
  } catch { /* info extraction optional */ }
  await parser.destroy();
  return {
    text: textResult.text ?? '',
    numpages: textResult.total ?? textResult.pages.length,
    pages: textResult.pages ?? [],
    info,
  };
}

const server = new McpServer({
  name: 'nanoclaw-pdf',
  version: '1.0.0',
});

server.tool(
  'read_pdf',
  'Extract text content from a PDF file. Returns the full text and page count. Use this when a user sends a PDF or asks you to read/analyze a PDF document.',
  {
    file_path: z.string().describe('Absolute path to the PDF file'),
    pages: z.string().optional().describe('Page range to extract (e.g. "1-5", "1,3,5"). Default: all pages'),
  },
  async (args) => {
    try {
      const filePath = args.file_path;

      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: `Error: File not found: ${filePath}` }],
        };
      }

      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.pdf') {
        return {
          content: [{ type: 'text' as const, text: `Error: Not a PDF file (got ${ext})` }],
        };
      }

      const data = await parsePdf(filePath);

      let text = data.text;

      // If pages specified, try to extract only those pages
      // pdf-parse doesn't support page ranges natively, but we can approximate
      // by splitting on form feeds or page markers
      if (args.pages && data.pages.length > 0) {
        const requestedPages = parsePageRange(args.pages, data.numpages);
        text = requestedPages
          .map(p => data.pages.find(pg => pg.num === p)?.text)
          .filter(Boolean)
          .join('\n\n--- Page Break ---\n\n');
      }

      // Truncate if very long (to avoid blowing context window)
      const MAX_CHARS = 100000;
      const truncated = text.length > MAX_CHARS;
      if (truncated) {
        text = text.slice(0, MAX_CHARS) + '\n\n[... truncated ...]';
      }

      const summary = [
        `Pages: ${data.numpages}`,
        `Characters: ${data.text.length}`,
        truncated ? `(truncated to ${MAX_CHARS} chars)` : '',
        data.info?.Title ? `Title: ${data.info.Title}` : '',
        data.info?.Author ? `Author: ${data.info.Author}` : '',
      ].filter(Boolean).join(' | ');

      return {
        content: [{
          type: 'text' as const,
          text: `📄 PDF: ${path.basename(filePath)}\n${summary}\n\n${text}`,
        }],
      };
    } catch (err: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading PDF: ${err.message}`,
        }],
      };
    }
  },
);

function parsePageRange(spec: string, totalPages: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(Number);
      for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
        pages.add(i);
      }
    } else {
      const n = Number(trimmed);
      if (n >= 1 && n <= totalPages) pages.add(n);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

const transport = new StdioServerTransport();
await server.connect(transport);

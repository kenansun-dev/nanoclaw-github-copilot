/**
 * GitHub Token Provider
 *
 * Unified token resolution for GitHub Copilot authentication.
 * Used by: SDK session auth, GitHub MCP server, container env injection.
 *
 * Resolution order:
 *   1. Environment variables (COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN)
 *   2. ~/.copilot/config.json copilot_tokens (CLI file-based storage)
 *   3. Windows Credential Manager (copilot-cli/* entries) — Windows only
 *   4. null (let SDK handle via useLoggedInUser / CLI managed auth)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from './logger.js';

/**
 * Resolve a GitHub token from available sources.
 * Returns the token string or undefined if not found.
 */
export function resolveGithubToken(): string | undefined {
  // 1. Explicit environment variables (highest priority)
  const envToken =
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();

  // 2. ~/.copilot/config.json copilot_tokens (CLI file-based storage)
  const copilotConfigPaths = [
    path.join(home, '.copilot', 'config.json'),
    path.join(home, '.config', 'github-copilot', 'config.json'),
  ];
  for (const configFile of copilotConfigPaths) {
    try {
      if (!fs.existsSync(configFile)) continue;
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (
        config.copilot_tokens &&
        typeof config.copilot_tokens === 'object'
      ) {
        for (const [, token] of Object.entries(config.copilot_tokens)) {
          if (typeof token === 'string' && token.length > 4) return token;
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Windows Credential Manager (copilot-cli/* entries)
  if (process.platform === 'win32') {
    const credToken = readWindowsCredential();
    if (credToken) return credToken;
  }

  // 4. Not found — caller should let SDK handle via useLoggedInUser
  return undefined;
}

/**
 * Read copilot CLI token from Windows Credential Manager.
 * Looks for entries matching copilot-cli/https://github.com:*
 * Returns the first valid token found, preferring the last_logged_in_user.
 */
function readWindowsCredential(): string | null {
  try {
    // Determine preferred user from copilot config
    let preferredUser: string | null = null;
    const configPath = path.join(os.homedir(), '.copilot', 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        preferredUser = config.last_logged_in_user?.login || null;
      }
    } catch { /* ignore */ }

    // Build target — try preferred user first, then any copilot-cli entry
    const targets = preferredUser
      ? [
          `copilot-cli/https://github.com:${preferredUser}`,
          // List all to find alternatives
        ]
      : [];

    // Discover available copilot-cli credentials
    try {
      const listOutput = execSync('cmdkey /list', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      const lines = listOutput.split('\n');
      for (const line of lines) {
        const match = line.match(/copilot-cli\/https:\/\/github\.com:\S+/);
        if (match && !targets.includes(match[0])) {
          targets.push(match[0]);
        }
      }
    } catch { /* cmdkey not available */ }

    // Try to read each credential
    for (const target of targets) {
      const token = readSingleCredential(target);
      if (token && (token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('ghp_'))) {
        logger.debug({ target }, 'Read GitHub token from Windows Credential Manager');
        return token;
      }
    }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to read Windows Credential Manager',
    );
  }
  return null;
}

/**
 * Read a single credential value from Windows Credential Manager using PowerShell.
 */
function readSingleCredential(target: string): string | null {
  try {
    // Use .NET interop via PowerShell to read credential blob
    const psScript = `
$code = 'using System; using System.Runtime.InteropServices; using System.Text; public class NcCR { [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredRead(string t, int ty, int f, out IntPtr c); [DllImport("advapi32.dll")] static extern void CredFree(IntPtr b); [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct CRED { public int F; public int T; public string TN; public string C; public long LW; public int CBS; public IntPtr CB; public int P; public int AC; public IntPtr A; public string TA; public string UN; } public static string Read(string t) { IntPtr p; if(!CredRead(t,1,0,out p)) return ""; var c=Marshal.PtrToStructure<CRED>(p); byte[] b=new byte[c.CBS]; Marshal.Copy(c.CB,b,0,c.CBS); CredFree(p); return Encoding.UTF8.GetString(b); } }'
try { Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue } catch {}
[NcCR]::Read('${target.replace(/'/g, "''")}')
`.trim();

    const result = execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      },
    ).trim();

    return result || null;
  } catch {
    return null;
  }
}

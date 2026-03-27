/**
 * Credential proxy for container isolation (Copilot SDK version).
 *
 * With Copilot SDK, the auth model is different from Anthropic's:
 * - Copilot CLI handles its own auth via GitHub OAuth (stored credentials)
 * - For BYOK mode, API keys are passed to the SDK directly
 *
 * This proxy now supports two modes:
 * 1. GitHub auth: Pass GITHUB_TOKEN or GH_TOKEN to the container
 *    (Copilot CLI uses stored OAuth by default, but we can inject tokens)
 * 2. BYOK passthrough: Proxy API requests with injected keys for
 *    custom providers (OpenAI, Anthropic, Azure, etc.)
 *
 * For standard Copilot auth, the proxy is optional — Copilot CLI
 * authenticates directly with GitHub. The proxy is mainly needed for
 * BYOK scenarios where you don't want keys in the container.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'github' | 'byok-openai' | 'byok-anthropic';

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    // BYOK keys (optional)
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]);

  // Determine auth mode
  const authMode: AuthMode =
    secrets.OPENAI_API_KEY || secrets.AZURE_OPENAI_API_KEY
      ? 'byok-openai'
      : secrets.ANTHROPIC_API_KEY
        ? 'byok-anthropic'
        : 'github';

  // For BYOK Anthropic, use the same upstream proxy as before
  const anthropicUpstream = secrets.ANTHROPIC_BASE_URL
    ? new URL(secrets.ANTHROPIC_BASE_URL)
    : new URL('https://api.anthropic.com');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        if (authMode === 'github') {
          // GitHub auth mode: proxy is not needed for standard Copilot auth
          // Return 200 with info message
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              message: 'GitHub auth mode — Copilot CLI handles auth directly',
            }),
          );
          return;
        }

        if (authMode === 'byok-anthropic') {
          // Same as original: proxy to Anthropic with injected key
          const isHttps = anthropicUpstream.protocol === 'https:';
          const makeRequest = isHttps ? httpsRequest : httpRequest;

          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: anthropicUpstream.host,
            'content-length': body.length,
          };

          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;

          const upstream = makeRequest(
            {
              hostname: anthropicUpstream.hostname,
              port: anthropicUpstream.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
          return;
        }

        if (authMode === 'byok-openai') {
          // OpenAI/Azure BYOK: proxy to OpenAI-compatible endpoint with injected key
          const openaiBase = secrets.AZURE_OPENAI_API_KEY
            ? new URL(
                process.env.AZURE_OPENAI_ENDPOINT || 'https://api.openai.com',
              )
            : new URL('https://api.openai.com');

          const isHttps = openaiBase.protocol === 'https:';
          const makeRequest = isHttps ? httpsRequest : httpRequest;

          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: openaiBase.host,
            'content-length': body.length,
          };

          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];
          delete headers['authorization'];

          if (secrets.AZURE_OPENAI_API_KEY) {
            headers['api-key'] = secrets.AZURE_OPENAI_API_KEY;
          } else {
            headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
          }

          const upstream = makeRequest(
            {
              hostname: openaiBase.hostname,
              port: openaiBase.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        }
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
  ]);
  if (secrets.OPENAI_API_KEY || secrets.AZURE_OPENAI_API_KEY)
    return 'byok-openai';
  if (secrets.ANTHROPIC_API_KEY) return 'byok-anthropic';
  return 'github';
}

#!/usr/bin/env node
/**
 * Ecko Notes — zero-dependency static dev server.
 *
 * Binds 0.0.0.0 so it works behind a proxy/preview host, and accepts any
 * Host/Origin header (there is no origin allowlist to get in the way).
 *
 * The Document Picture-in-Picture API needs a secure context, and `localhost`
 * counts as one, so http://localhost:PORT is enough for local development.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Resolve a URL path to a file inside ROOT, or null if it escapes. */
function safeResolve(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0].split('#')[0]);
  const candidate = resolve(join(ROOT, normalize(decoded).replace(/^(\.\.[/\\])+/, '')));
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
  return candidate;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  let target = safeResolve(req.url || '/');
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, 'index.html');
  } catch {
    // Fall back to the app shell so deep links / reloads work.
    target = join(ROOT, 'index.html');
  }

  try {
    const info = await stat(target);
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Ecko Notes  →  http://localhost:${PORT}  (bound ${HOST})`);
});

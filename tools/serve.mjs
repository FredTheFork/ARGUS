/**
 * serve.mjs — zero-dependency development server for ARGUS.
 *
 * Serves the repository with the headers this app actually needs:
 *
 *   Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy: same-origin
 *   — makes the page cross-origin isolated, which is what allows
 *   SharedArrayBuffer and therefore multi-threaded onnxruntime-web. Without it
 *   inference silently drops to one thread.
 *
 *   Correct MIME types for .wasm, .mjs and .onnx — ORT refuses a WASM binary
 *   served as text/plain.
 *
 * Usage:  node tools/serve.mjs [port] [--host 0.0.0.0]
 * Default: http://localhost:8080  (camera needs https or localhost)
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : '.', '.');
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a))) || Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path.endsWith('/')) path += 'index.html';
    const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 ${path}`);
      console.log(`404 ${path}`);
      return;
    }
    const body = await readFile(target);
    const type = TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        const slice = body.subarray(start, end + 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': slice.length, 'Accept-Ranges': 'bytes' });
        res.end(slice);
        console.log(`206 ${path} ${start}-${end} (${Date.now() - started} ms)`);
        return;
      }
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
    if (!/\.(woff2?|png|ico)$/.test(path)) console.log(`200 ${path} ${(body.length / 1024).toFixed(0)} kB (${Date.now() - started} ms)`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`500 ${err.message}`);
    console.log(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ARGUS dev server — http://localhost:${PORT}  (root ${ROOT}, host ${HOST})`);
  console.log('cross-origin isolated: on  ·  wasm/mjs/onnx MIME types: on');
});

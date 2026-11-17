// App server: serves the offline-package manager UI (the part that stays local).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLIENT = path.join(ROOT, 'src', 'client');
export const APP_PORT = Number(process.env.APP_PORT ?? 4100);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createAppServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel === '' || rel === '.') rel = 'index.html';
    const file = path.join(CLIENT, rel);
    if (!file.startsWith(CLIENT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end(`not found: ${rel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createAppServer().listen(APP_PORT, () => {
    console.log(`[app] manager UI on http://localhost:${APP_PORT}`);
  });
}

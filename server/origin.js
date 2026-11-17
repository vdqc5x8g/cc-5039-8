// Origin server: the "network" that goes away in the field.
// Serves catalog, manifests and media objects from origin-data/ with CORS enabled.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'origin-data');
export const ORIGIN_PORT = Number(process.env.ORIGIN_PORT ?? 4101);

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.vtt': 'text/vtt; charset=utf-8',
};

export function createOriginServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url, 'http://x');
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const file = path.join(DATA, rel);
    if (!file.startsWith(DATA) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end(`not found: ${rel}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
    });
    fs.createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createOriginServer().listen(ORIGIN_PORT, () => {
    console.log(`[origin] media origin on http://localhost:${ORIGIN_PORT}`);
  });
}

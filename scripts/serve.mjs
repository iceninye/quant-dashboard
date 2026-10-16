// serve.mjs — 本地預覽（127.0.0.1:8123）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const PORT = Number(process.env.PORT || 8123);
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(DOCS, p === '/' ? 'index.html' : p);
  if (!f.startsWith(DOCS)) { res.writeHead(403).end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }).end(d);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/`));

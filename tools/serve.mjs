/**
 * serve.mjs —— 零依赖静态服务器
 *
 * 浏览器的 ES Module + fetch 不允许走 file://，所以本地必须起一个 http 服务。
 * 用法：node tools/serve.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5188);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let rel = decodeURIComponent(parsed.pathname);
  if (rel === '/') rel = '/index.html';

  const target = path.join(ROOT, rel);
  // 目录穿越防护
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': st.size,
    });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KLrun 已启动： http://127.0.0.1:${PORT}/`);
  console.log(`静态根目录： ${ROOT}`);
});

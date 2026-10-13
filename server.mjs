import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject' };

// Only serves built files. There is no translation endpoint or runtime API key.
export function createApp({ directory = resolve(root, 'dist') } = {}) {
  directory = resolve(directory);
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end('Local access only'); }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end('Static files only'); }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); return res.end('Invalid URL'); }
    if (path === '/') path = '/index.html';
    const filename = resolve(directory, `.${path}`);
    if (!filename.startsWith(directory + sep) || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part.startsWith('.'))) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new Error();
      const body = await readFile(filename);
      res.writeHead(200, { 'Content-Type': mime[extname(filename)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('檔案不存在。請先執行 npm run sync、npm run translate、npm run build。');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const server = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`Musicmap 中文：http://localhost:${port}\n靜態閱讀版：瀏覽及切換語言不會呼叫 DeepSeek。`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT in .env.` : 'Unable to start local server.'); process.exitCode = 1; });
}

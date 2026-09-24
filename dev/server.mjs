// 本地开发服务器（零依赖 Node）：静态 web/ + SPA 回退 + /functions/v1/app 直连 handler。
// 用法：node dev/server.mjs [port]   默认 4173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGames } from '../functions/handler.mjs';
import { createFakeSupabase } from './fake-supabase.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const webDir = join(root, 'web');
const port = Number(process.argv[2] || 4173);
const supabase = createFakeSupabase();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveFunction(req, res) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const method = req.method || 'GET';
  let body;
  if (method !== 'GET' && method !== 'HEAD') body = await readBody(req); // Buffer（勿传 .buffer，池偏移会混入脏字节）
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method, headers, body });
  const result = await handleGames({ request, supabase });
  const buf = Buffer.from(await result.arrayBuffer());
  res.writeHead(result.status, Object.fromEntries(result.headers));
  res.end(buf);
}

async function serveStatic(req, res, pathname) {
  let file = normalize(join(webDir, decodeURIComponent(pathname)));
  if (!file.startsWith(webDir)) { res.writeHead(403).end('forbidden'); return; }
  let exists = false;
  try { exists = (await stat(file)).isFile(); } catch { /* miss */ }
  if (!exists) { file = join(webDir, 'index.html'); } // SPA 回退
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (pathname.startsWith('/functions/v1/app')) await serveFunction(req, res);
    else await serveStatic(req, res, pathname);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`dev server error: ${err.message}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`篮球计分板本地预览: http://127.0.0.1:${port}/  （数据为本地内存假库，重启即清空）`);
});

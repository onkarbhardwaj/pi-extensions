import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanvasError, StaleError, addComment, canvasDir, canvasExists, canvasName, changeComment, changeFrame,
  frameDir, isFrameId, listCanvases, readComments, readManifest,
} from './core.ts';

/**
 * One canvas server per machine, hosted by whichever Pi session holds the port. The port is the lock:
 * a session that cannot listen asks /health and uses the server it finds. The server keeps no state.
 */

export const APP = 'pi-canvas';
const PAGE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'page');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** A frame may load its own files and nothing else; it cannot post forms or be embedded anywhere but the canvas. */
export const frameCsp = (port: number) =>
  `default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors http://localhost:${port}`;
const pageCsp = (port: number) =>
  `default-src 'self'; img-src 'self' data:; style-src 'self'; frame-src http://*.localhost:${port}; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`;

export type Host = { port: number; hosting: boolean; version: string; close(): Promise<void> };

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw new CanvasError('Request too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new CanvasError('Body must be JSON.'); }
}

/** Resolve a URL path inside a folder, refusing anything that would leave it. */
function safeJoin(root: string, urlPath: string) {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const full = normalize(join(root, decoded));
  return full === root || full.startsWith(root + sep) ? full : null;
}

async function serveFile(res: ServerResponse, root: string, urlPath: string, headers: Record<string, string>) {
  let path = safeJoin(root, urlPath);
  if (!path) return send(res, 400, 'Bad path');
  const info = await stat(path).catch(() => null);
  if (info?.isDirectory()) { path = join(path, 'index.html'); }
  const data = await readFile(path).catch(() => null);
  if (!data) return send(res, 404, 'Not found', 'text/plain; charset=utf-8', headers);
  send(res, 200, data, TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', headers);
}

export function createHandler(storage: string, port: number, version: string) {
  const streams = new Map<string, { clients: Set<ServerResponse>; watcher: FSWatcher; timer?: NodeJS.Timeout }>();
  const canvasOrigin = `http://localhost:${port}`;

  const subscribe = (name: string, res: ServerResponse) => {
    let entry = streams.get(name);
    if (!entry) {
      const clients = new Set<ServerResponse>();
      const watcher = watch(canvasDir(storage, name), (_event, file) => {
        if (file !== 'manifest.json' && file !== 'comments.json') return;
        const e = streams.get(name); if (!e) return;
        clearTimeout(e.timer);
        e.timer = setTimeout(() => { for (const c of e.clients) c.write('event: change\ndata: {}\n\n'); }, 50);
      });
      entry = { clients, watcher };
      streams.set(name, entry);
    }
    entry.clients.add(res);
    res.on('close', () => {
      entry!.clients.delete(res);
      if (!entry!.clients.size) { entry!.watcher.close(); clearTimeout(entry!.timer); streams.delete(name); }
    });
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const url = new URL(req.url ?? '/', 'http://x');

    // A frame, on its own origin: <frame>--<canvas>.localhost
    const frameHost = /^([a-f0-9]{8})--([a-z0-9-]+)\.localhost$/.exec(hostname);
    if (frameHost) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Frames are read-only');
      const [, id, name] = frameHost;
      if (!isFrameId(id) || !(await canvasExists(storage, name))) return send(res, 404, 'No such frame');
      return serveFile(res, frameDir(storage, name, id), url.pathname, { 'content-security-policy': frameCsp(port) });
    }
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') return send(res, 421, 'Unknown host');

    if (url.pathname === '/health') return json(res, 200, { app: APP, version, port });
    if (url.pathname.startsWith('/_/')) return serveFile(res, PAGE_DIR, url.pathname.slice(3), {});
    if (url.pathname === '/') {
      const list = await listCanvases(storage);
      const items = list.map(c => `<li><a href="/${c.name}/">${c.name}</a></li>`).join('') || '<li>No canvases yet.</li>';
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Canvases</title><link rel="stylesheet" href="/_/canvas.css"><main class="index"><h1>Canvases</h1><ul>${items}</ul></main>`,
        'text/html; charset=utf-8', { 'content-security-policy': pageCsp(port) });
    }

    const parts = url.pathname.split('/').filter(Boolean);
    let name: string;
    try { name = canvasName(parts[0]); } catch { return send(res, 404, 'Not found'); }
    if (name !== parts[0] || !(await canvasExists(storage, name))) return send(res, 404, 'No such canvas');

    if (parts.length === 1) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { location: `/${name}/` }); return res.end(); }
      const page = (await readFile(join(PAGE_DIR, 'index.html'), 'utf8')).replaceAll('{{canvas}}', name);
      return send(res, 200, page, 'text/html; charset=utf-8', { 'content-security-policy': pageCsp(port) });
    }
    if (parts[1] !== 'api') return send(res, 404, 'Not found');

    // Only the canvas page itself may change things.
    if (req.method !== 'GET' && req.headers.origin !== canvasOrigin) return send(res, 403, 'Forbidden origin');
    try {
      const [, , what, id] = parts;
      if (what === 'state' && req.method === 'GET') {
        const [manifest, comments] = await Promise.all([readManifest(storage, name), readComments(storage, name)]);
        return json(res, 200, { canvas: name, port, frames: manifest.frames, comments });
      }
      if (what === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        return subscribe(name, res);
      }
      if (what === 'move' && req.method === 'POST') {
        const b = await body(req);
        return json(res, 200, { frame: await changeFrame(storage, name, String(b.frame), { kind: 'move', x: Number(b.x), y: Number(b.y), hash: String(b.hash) }) });
      }
      if (what === 'comments' && req.method === 'POST' && !id) {
        const b = await body(req);
        return json(res, 200, { comment: await addComment(storage, name, { frame: String(b.frame), x: Number(b.x), y: Number(b.y), text: String(b.text ?? '') }) });
      }
      if (what === 'comments' && id && req.method === 'PATCH') {
        const b = await body(req);
        return json(res, 200, { comment: await changeComment(storage, name, id, { text: b.text, state: b.state }) });
      }
      if (what === 'comments' && id && req.method === 'DELETE') {
        await changeComment(storage, name, id, 'delete');
        return json(res, 200, { deleted: id });
      }
      return send(res, 404, 'Not found');
    } catch (error) {
      if (error instanceof StaleError) return json(res, 409, { error: error.message, current: error.current });
      if (error instanceof CanvasError) return json(res, 400, { error: error.message });
      throw error;
    }
  };
  const closeStreams = () => { for (const s of streams.values()) { s.watcher.close(); for (const c of s.clients) c.end(); } streams.clear(); };
  return { handler, closeStreams };
}

/** Ask whatever holds the port who it is. */
export function health(port: number): Promise<{ app?: string; version?: string } | null> {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/health', timeout: 2000, headers: { host: `localhost:${port}` } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Host the server if the port is free; otherwise use the canvas server already on it. */
export async function ensureServer(storage: string, port: number, version: string): Promise<Host> {
  const { handler, closeStreams } = createHandler(storage, port, version);
  const server: Server = createServer((req, res) => {
    handler(req, res).catch(error => { if (!res.headersSent) send(res, 500, String(error?.message ?? error)); else res.end(); });
  });
  const listened = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (listened) {
    server.unref();
    return {
      port, hosting: true, version,
      close: () => new Promise(r => { closeStreams(); server.closeAllConnections?.(); server.close(() => r()); }),
    };
  }
  const found = await health(port);
  if (found?.app !== APP) throw new CanvasError(`Port ${port} is used by another program. Set "port" in ~/.pi/agent/canvas.json to a free port.`);
  return { port, hosting: false, version: found.version ?? 'unknown', close: async () => {} };
}

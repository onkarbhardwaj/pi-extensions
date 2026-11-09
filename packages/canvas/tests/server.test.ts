import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addFrames, ensureCanvas } from '../src/core.ts';
import { APP, ensureServer, frameCsp } from '../src/server.ts';

const free = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as any; s.close(() => resolve(port)); }); });

function get(port: number, host: string, path: string, method = 'GET', body?: unknown, origin?: string) {
  return new Promise<{ status: number; headers: any; text: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `${host}:${port}`, ...(origin ? { origin } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-server-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = join(dir, 'storage');
  await ensureCanvas(storage, 'todo', dir);
  const site = join(dir, 'site'); await mkdir(join(site, 'data'), { recursive: true });
  await writeFile(join(site, 'index.html'), '<h1>todo</h1>');
  await writeFile(join(site, 'data', 'items.json'), '[]');
  const [frame] = await addFrames(storage, 'todo', [{ folder: site, title: 'V1', width: 390, height: 844 }]);
  const port = await free();
  const host = await ensureServer(storage, port, '0.1.0');
  t.after(() => host.close());
  return { storage, port, host, frame };
}

test('the first session hosts; another uses the same server; a stranger on the port is reported', async t => {
  const { storage, port, host } = await setup(t);
  assert.equal(host.hosting, true);
  const second = await ensureServer(storage, port, '0.1.0');
  assert.equal(second.hosting, false);
  const health = JSON.parse((await get(port, 'localhost', '/health')).text);
  assert.equal(health.app, APP);

  const strangerPort = await free();
  const stranger = createServer((_q, r) => r.end('hello')); await new Promise<void>(r => stranger.listen(strangerPort, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>(r => stranger.close(() => r())));
  await assert.rejects(ensureServer(storage, strangerPort, '0.1.0'), /used by another program/);
});

test('when the host stops, the next session takes over on the same port', async t => {
  const { storage, port, host } = await setup(t);
  await host.close();
  const next = await ensureServer(storage, port, '0.1.0');
  t.after(() => next.close());
  assert.equal(next.hosting, true);
});

test('frames are served on their own origin with the content policy', async t => {
  const { port, frame } = await setup(t);
  const host = `${frame.id}--todo.localhost`;
  const page = await get(port, host, '/index.html');
  assert.equal(page.status, 200);
  assert.equal(page.text, '<h1>todo</h1>');
  assert.equal(page.headers['content-security-policy'], frameCsp(port));
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal((await get(port, host, '/data/items.json')).text, '[]');
  // Encoded dot segments are collapsed by URL parsing, so they stay inside the frame and find nothing.
  for (const path of ['/%2e%2e/%2e%2e/manifest.json', '/../../manifest.json', '/..%2f..%2fmanifest.json']) {
    const escape = await get(port, host, path);
    assert.notEqual(escape.status, 200, path);
    assert.doesNotMatch(escape.text, /frames/, path);
  }
  assert.equal((await get(port, host, '/index.html', 'POST', {})).status, 405);
  assert.equal((await get(port, 'deadbeef--todo.localhost', '/index.html')).status, 404);
  assert.equal((await get(port, 'example.com', '/health')).status, 421);
});

test('the canvas page and its state are served; changes need the canvas origin and a current hash', async t => {
  const { port, frame } = await setup(t);
  const page = await get(port, 'localhost', '/todo/');
  assert.equal(page.status, 200);
  assert.match(page.text, /data-canvas="todo"/);
  assert.match(page.headers['content-security-policy'], /frame-src http:\/\/\*\.localhost/);
  const state = JSON.parse((await get(port, 'localhost', '/todo/api/state')).text);
  assert.equal(state.frames[0].id, frame.id);

  const origin = `http://localhost:${port}`;
  assert.equal((await get(port, 'localhost', '/todo/api/move', 'POST', { frame: frame.id, x: 1, y: 1, hash: frame.hash })).status, 403);
  assert.equal((await get(port, 'localhost', '/todo/api/move', 'POST', { frame: frame.id, x: 1, y: 1, hash: frame.hash }, `http://${frame.id}--todo.localhost:${port}`)).status, 403);
  const moved = await get(port, 'localhost', '/todo/api/move', 'POST', { frame: frame.id, x: 10, y: 10, hash: frame.hash }, origin);
  assert.equal(moved.status, 200);
  assert.equal((await get(port, 'localhost', '/todo/api/move', 'POST', { frame: frame.id, x: 20, y: 20, hash: frame.hash }, origin)).status, 409);

  const added = JSON.parse((await get(port, 'localhost', '/todo/api/comments', 'POST', { frame: frame.id, x: 5, y: 6, text: 'Hi' }, origin)).text);
  assert.equal(added.comment.text, 'Hi');
  const resolved = JSON.parse((await get(port, 'localhost', `/todo/api/comments/${added.comment.id}`, 'PATCH', { state: 'resolved' }, origin)).text);
  assert.equal(resolved.comment.state, 'resolved');
  assert.equal((await get(port, 'localhost', '/nope/')).status, 404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addComment, addFrames, ensureCanvas, frameOrigin, canvasUrl } from '../src/core.ts';
import { ensureServer } from '../src/server.ts';
import { screenshot } from '../src/browser.ts';

// Runs against a real Chromium when one is available: set CANVAS_TEST_CHROME, or it looks in the usual places.
const CHROME = [process.env.CANVAS_TEST_CHROME, '/opt/pw-browsers/chromium/chrome-linux64/chrome', '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .find(p => p && existsSync(p));

const free = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address() as any; s.close(() => resolve(port)); }); });

async function chrome(t: any) {
  const port = await free();
  const profile = await mkdtemp(join(tmpdir(), 'canvas-chrome-'));
  const child = spawn(CHROME!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const exited = new Promise(r => child.once('exit', r));
    child.kill('SIGKILL'); await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${endpoint}/json/version`)).ok) return endpoint; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Chromium did not start');
}

/** Evaluate in a page through the DevTools protocol and return the value. */
async function evaluate(endpoint: string, url: string, expression: string, waitMs = 1500) {
  const info = await (await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  await new Promise(r => setTimeout(r, waitMs));
  const value = await new Promise<any>(resolve => {
    ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id === 1) resolve(m.result?.result?.value); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  await fetch(`${endpoint}/json/close/${info.id}`);
  return value;
}

test('frames, isolation, screenshots and the canvas page in a real browser', { skip: !CHROME && 'no Chromium found' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = join(dir, 'storage');
  await ensureCanvas(storage, 'todo', dir);

  // Something outside the frame that a frame must not reach.
  const outsidePort = await free();
  const outside = createServer((_q, r) => { r.setHeader('access-control-allow-origin', '*'); r.end('secret'); });
  await new Promise<void>(r => outside.listen(outsidePort, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>(r => outside.close(() => r())));

  const site = join(dir, 'site'); await mkdir(site, { recursive: true });
  await writeFile(join(site, 'index.html'), `<!doctype html><body style="margin:0;background:rgb(10,200,30)"><script>
    localStorage.setItem('todos', JSON.stringify(['milk']));
    window.result = (async () => {
      const own = await fetch('data.json').then(r => r.json()).catch(() => null);
      const external = await fetch('http://127.0.0.1:${outsidePort}/').then(r => r.text()).catch(() => 'blocked');
      return { storage: JSON.parse(localStorage.getItem('todos')), own, external, origin: location.origin };
    })();
  </script></body>`);
  await writeFile(join(site, 'data.json'), '{"ok":true}');
  const [frame] = await addFrames(storage, 'todo', [{ folder: site, title: 'V1', width: 390, height: 300 }]);
  await addComment(storage, 'todo', { frame: frame.id, x: 30, y: 40, text: 'Hello' });

  const port = await free();
  const host = await ensureServer(storage, port, 'test');
  t.after(() => host.close());
  const endpoint = await chrome(t);
  const url = `${frameOrigin(port, 'todo', frame.id)}/index.html`;

  const result = await evaluate(endpoint, url, 'window.result');
  assert.deepEqual(result.storage, ['milk'], 'localStorage works on the frame origin');
  assert.deepEqual(result.own, { ok: true }, 'the frame can load its own files');
  assert.equal(result.external, 'blocked', 'the content policy blocks other addresses');
  assert.equal(result.origin, `http://${frame.id}--todo.localhost:${port}`);

  const png = await screenshot(endpoint, url, 390, 300);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 390);
  assert.equal(png.readUInt32BE(20), 300);

  const page = await evaluate(endpoint, canvasUrl(port, 'todo'), `({
    frames: document.querySelectorAll('.frame iframe').length,
    src: document.querySelector('.frame iframe')?.src,
    pins: document.querySelectorAll('.pin').length,
    summary: document.querySelector('#summary').textContent,
  })`, 2500);
  assert.equal(page.frames, 1);
  assert.equal(page.src, url);
  assert.equal(page.pins, 1);
  assert.match(page.summary, /1 frame · 1 open comment/);
});

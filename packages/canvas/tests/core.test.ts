import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMENTS_MESSAGE_TYPE, ProblemsError, StaleError, addComment, addFrames, canvasName, changeComment, changeFrame,
  checkFolder, commentsUpdate, ensureCanvas, frameDir, lastCanvasFor, lastSentComments, parseConfig, readComments,
  readManifest, rememberCanvas, statusText,
} from '../src/core.ts';

async function folder(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'canvas-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function page(dir: string, name: string, html = '<h1>todo</h1>') {
  const root = join(dir, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.html'), html);
  return root;
}

async function setup(t: any) {
  const dir = await folder(t);
  const storage = join(dir, 'storage');
  await ensureCanvas(storage, 'todo', dir);
  return { dir, storage };
}

/** What the model's context holds once a comments message was sent. */
const sent = (update: any) => ({ type: 'custom_message', ...update, details: { canvases: [update.details] } });

test('config has defaults and refuses unknown or invalid settings', () => {
  const c = parseConfig(undefined, '/agent');
  assert.deepEqual(c, { port: 4848, storage: '/agent/canvas', comments: 'live', browser: {} });
  const d = parseConfig({ port: 5000, storage: '~/c', comments: 'review', browser: { cdp: 'http://127.0.0.1:9222/' } }, '/agent');
  assert.equal(d.storage, join(homedir(), 'c'));
  assert.equal(d.browser.cdp, 'http://127.0.0.1:9222');
  assert.throws(() => parseConfig({ colour: 'red' }, '/a'), /unknown setting/);
  assert.throws(() => parseConfig({ port: 80 }, '/a'), /port/);
  assert.throws(() => parseConfig({ storage: 'relative' }, '/a'), /absolute/);
  assert.throws(() => parseConfig({ browser: { cdp: 'ws://x' } }, '/a'), /browser.cdp/);
});

test('canvas names are safe in paths and host names', () => {
  assert.equal(canvasName('Todo App: Mobile'), 'todo-app-mobile');
  assert.throws(() => canvasName('***'), /letters or digits/);
});

test('a folder with secrets, links or a missing entry is refused with fixes', async t => {
  const dir = await folder(t);
  const bad = await page(dir, 'bad');
  await writeFile(join(bad, '.env'), 'KEY=1');
  await writeFile(join(bad, 'app.js.map'), '{}');
  await symlink(join(bad, 'index.html'), join(bad, 'link.html'));
  const { problems } = await checkFolder(bad, 'index.html', join(dir, 'storage'));
  assert.deepEqual(problems.map(p => p.file).sort(), ['.env', 'app.js.map', 'link.html']);
  assert.ok(problems.every(p => p.fix));
  const missing = await checkFolder(await page(dir, 'ok'), 'other.html', join(dir, 'storage'));
  assert.match(missing.problems[0].problem, /not in the folder/);
  const escape = await checkFolder(await page(dir, 'ok2'), '../x.html', join(dir, 'storage'));
  assert.match(escape.problems[0].problem, /relative path/);
});

test('frames are added in rows, copied, and nothing is placed if one fails', async t => {
  const { dir, storage } = await setup(t);
  const a = await page(dir, 'a'), b = await page(dir, 'b');
  const added = await addFrames(storage, 'todo', [
    { folder: a, title: 'Compact', width: 390, height: 844 },
    { folder: b, title: 'Roomy', width: 390, height: 844 },
  ]);
  assert.deepEqual(added.map(f => [f.x, f.y]), [[0, 0], [470, 0]]);
  assert.equal(await readFile(join(frameDir(storage, 'todo', added[0].id), 'index.html'), 'utf8'), '<h1>todo</h1>');
  const [row] = await addFrames(storage, 'todo', [{ folder: a, title: 'Desktop', width: 1280, height: 800, newRow: true }]);
  assert.deepEqual([row.x, row.y], [0, 924]);
  const bad = await page(dir, 'bad'); await writeFile(join(bad, '.env'), 'x');
  await assert.rejects(addFrames(storage, 'todo', [{ folder: a, title: 'Fine', width: 400, height: 400 }, { folder: bad, title: 'Bad', width: 400, height: 400 }]), ProblemsError);
  assert.equal((await readManifest(storage, 'todo')).frames.length, 3);
  await assert.rejects(addFrames(storage, 'todo', [{ folder: a, title: 'Compact', width: 390, height: 844 }]), /exists/);
});

test('concurrent adds both survive', async t => {
  const { dir, storage } = await setup(t);
  const a = await page(dir, 'a');
  await Promise.all(Array.from({ length: 6 }, (_, i) => addFrames(storage, 'todo', [{ folder: a, title: `V${i}`, width: 300, height: 300 }])));
  assert.equal((await readManifest(storage, 'todo')).frames.length, 6);
});

test('a change based on a stale hash is refused; update keeps comments', async t => {
  const { dir, storage } = await setup(t);
  const a = await page(dir, 'a');
  const [frame] = await addFrames(storage, 'todo', [{ folder: a, title: 'V1', width: 390, height: 844 }]);
  await addComment(storage, 'todo', { frame: 'V1', x: 20, y: 30, text: 'Badge too loud' });
  const moved = await changeFrame(storage, 'todo', frame.id, { kind: 'move', x: 500, y: 0, hash: frame.hash });
  assert.notEqual(moved!.hash, frame.hash);
  await assert.rejects(changeFrame(storage, 'todo', frame.id, { kind: 'move', x: 0, y: 0, hash: frame.hash }), StaleError);
  const v2 = await page(dir, 'v2', '<h1>quieter</h1>');
  const updated = await changeFrame(storage, 'todo', 'V1', { kind: 'update', folder: v2, hash: moved!.hash });
  assert.equal(await readFile(join(frameDir(storage, 'todo', frame.id), 'index.html'), 'utf8'), '<h1>quieter</h1>');
  assert.equal((await readComments(storage, 'todo')).length, 1);
  await changeFrame(storage, 'todo', 'V1', { kind: 'remove', hash: updated!.hash });
  assert.equal((await readManifest(storage, 'todo')).frames.length, 0);
  assert.equal((await readComments(storage, 'todo')).length, 0);
});

test('comments reach the model once per change, with new and resolved marked', async t => {
  const { dir, storage } = await setup(t);
  const [frame] = await addFrames(storage, 'todo', [{ folder: await page(dir, 'a'), title: 'V1', width: 390, height: 844 }]);
  const frames = [frame];
  assert.equal(commentsUpdate('todo', [], frames, undefined), undefined);

  const first = await addComment(storage, 'todo', { frame: frame.id, x: 10, y: 20, text: 'Too loud' });
  const one = commentsUpdate('todo', await readComments(storage, 'todo'), frames, undefined)!;
  assert.equal(one.customType, COMMENTS_MESSAGE_TYPE);
  assert.match(one.content, /NEW "V1" \(.+\) at 10,20: Too loud/);

  const context = [sent(one)];
  assert.equal(commentsUpdate('todo', await readComments(storage, 'todo'), frames, lastSentComments(context, 'todo')), undefined);

  await addComment(storage, 'todo', { frame: frame.id, x: 5, y: 5, text: 'Bigger tap targets' });
  await changeComment(storage, 'todo', first.id, { state: 'resolved' });
  const two = commentsUpdate('todo', await readComments(storage, 'todo'), frames, lastSentComments(context, 'todo'))!;
  assert.match(two.content, /NEW .*Bigger tap targets/);
  assert.doesNotMatch(two.content, /Too loud/);
  assert.match(two.content, /Resolved or deleted since last time: 1/);

  // Compaction dropped the earlier message: send the current state once more.
  assert.ok(commentsUpdate('todo', await readComments(storage, 'todo'), frames, lastSentComments([], 'todo')));
});

test('the last canvas is remembered per project', async t => {
  const { storage } = await setup(t);
  await rememberCanvas(storage, '/p/one', 'todo');
  assert.equal(await lastCanvasFor(storage, '/p/one'), 'todo');
  assert.equal(await lastCanvasFor(storage, '/p/two'), undefined);
});

test('status text counts frames and open comments', () => {
  assert.equal(statusText(0, 0), '🖼 Canvas · empty');
  assert.equal(statusText(1, 2), '🖼 Canvas · 1 frame · 2 comments');
});

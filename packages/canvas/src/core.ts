import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Canvas storage, frames, comments and the messages that carry comments to a model. No Pi imports. */

export const DEFAULT_PORT = 4848;
export const LIMITS = { frameBytes: 50 * 1024 * 1024, fileBytes: 10 * 1024 * 1024, files: 2000, frames: 200, commentChars: 2000 };
export const COMMENTS_MESSAGE_TYPE = 'canvas-comments';

export type CommentMode = 'live' | 'review';
export type CanvasConfig = { port: number; storage: string; comments: CommentMode; browser: { cdp?: string } };

export type Frame = {
  id: string; title: string; entry: string; width: number; height: number;
  x: number; y: number; source: string | null; hash: string; updatedAt: string;
};
export type Manifest = { frames: Frame[] };
export type Comment = {
  id: string; frame: string; x: number; y: number; text: string;
  state: 'open' | 'resolved'; createdAt: string; updatedAt: string;
};
export type Problem = { file?: string; problem: string; fix: string };

export class CanvasError extends Error {}
/** A change based on a version of a frame that is no longer current. */
export class StaleError extends CanvasError {
  readonly current: Frame;
  constructor(current: Frame) {
    super(`Frame "${current.title}" changed since you read it (current hash ${current.hash}). Run list, then decide.`);
    this.current = current;
  }
}
/** A folder that cannot become a frame; nothing was changed. */
export class ProblemsError extends CanvasError {
  readonly problems: Problem[];
  constructor(problems: Problem[]) { super(problems.map(p => `${p.file ? `${p.file}: ` : ''}${p.problem}`).join('; ')); this.problems = problems; }
}

// ---------- configuration ----------

export function expandPath(path: string) {
  const full = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(full)) throw new CanvasError(`${path}: must be absolute or start with ~/.`);
  return full;
}

export function parseConfig(value: unknown, agentDir: string): CanvasConfig {
  const config: CanvasConfig = { port: DEFAULT_PORT, storage: join(agentDir, 'canvas'), comments: 'live', browser: {} };
  if (value === undefined) return config;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CanvasError('canvas.json must hold an object.');
  const v = value as Record<string, any>;
  for (const key of Object.keys(v)) {
    if (!['port', 'storage', 'comments', 'browser'].includes(key)) throw new CanvasError(`canvas.json: unknown setting "${key}".`);
  }
  if (v.port !== undefined) {
    if (!Number.isInteger(v.port) || v.port < 1024 || v.port > 65535) throw new CanvasError('canvas.json: port must be a whole number from 1024 to 65535.');
    config.port = v.port;
  }
  if (v.storage !== undefined) {
    if (typeof v.storage !== 'string' || !v.storage.trim()) throw new CanvasError('canvas.json: storage must be a non-empty path.');
    config.storage = expandPath(v.storage.trim());
  }
  if (v.comments !== undefined) {
    if (v.comments !== 'live' && v.comments !== 'review') throw new CanvasError('canvas.json: comments must be "live" or "review".');
    config.comments = v.comments;
  }
  if (v.browser !== undefined) {
    if (!v.browser || typeof v.browser !== 'object' || Array.isArray(v.browser)) throw new CanvasError('canvas.json: browser must be an object.');
    const cdp = v.browser.cdp;
    if (cdp !== undefined) {
      if (typeof cdp !== 'string' || !/^https?:\/\/[^/\s]+\/?$/.test(cdp)) throw new CanvasError('canvas.json: browser.cdp must be an address such as http://127.0.0.1:9222.');
      config.browser.cdp = cdp.replace(/\/$/, '');
    }
  }
  return config;
}

export async function loadConfig(path: string, agentDir: string): Promise<CanvasConfig> {
  let text: string | undefined;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (text === undefined) return parseConfig(undefined, agentDir);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CanvasError(`${path} is not valid JSON.`); }
  return parseConfig(value, agentDir);
}

// ---------- names and paths ----------

/** A canvas name usable in paths and in host names: lowercase letters, digits and single hyphens. */
export function canvasName(raw: string) {
  const name = raw.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!name) throw new CanvasError(`"${raw}" cannot be a canvas name; use letters or digits.`);
  return name;
}

export const isFrameId = (id: string) => /^[a-f0-9]{8}$/.test(id);
const newId = () => randomBytes(4).toString('hex');
export const canvasDir = (storage: string, name: string) => join(storage, canvasName(name));
const files = (dir: string) => ({
  meta: join(dir, 'canvas.json'), manifest: join(dir, 'manifest.json'), comments: join(dir, 'comments.json'),
  frames: join(dir, 'frames'), shots: join(dir, 'shots'), lock: join(dir, '.lock'),
});
export const frameDir = (storage: string, name: string, id: string) => join(files(canvasDir(storage, name)).frames, id);
export const shotPath = (storage: string, name: string, id: string) => join(files(canvasDir(storage, name)).shots, `${id}.png`);

/** The origin a frame is served from: its own, so frames are isolated from each other and from the canvas page. */
export const frameOrigin = (port: number, name: string, id: string) => `http://${id}--${canvasName(name)}.localhost:${port}`;
export const canvasUrl = (port: number, name: string) => `http://localhost:${port}/${canvasName(name)}/`;

// ---------- JSON files ----------

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

/** Write through a temporary file in the same folder, so a crash never leaves half a file. */
export async function writeJsonAtomic(path: string, value: unknown) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

/** Serializes changes to one canvas across sessions and processes. A lock older than 30 s is treated as abandoned. */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = files(dir).lock;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(lock).then(s => s.mtimeMs, () => Date.now()));
      if (age > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new CanvasError('The canvas is busy; try again.');
      await new Promise(r => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

// ---------- canvases ----------

export type CanvasMeta = { name: string; createdAt: string; project: string | null };

export async function ensureCanvas(storage: string, raw: string, project: string | null): Promise<CanvasMeta> {
  const name = canvasName(raw);
  const dir = canvasDir(storage, name);
  await mkdir(join(dir, 'frames'), { recursive: true });
  await mkdir(join(dir, 'shots'), { recursive: true });
  const meta: CanvasMeta = { name, createdAt: new Date().toISOString(), project };
  try { await writeFile(files(dir).meta, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' }); return meta; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return readJson(files(dir).meta, meta);
}

export async function canvasExists(storage: string, raw: string) {
  return stat(files(canvasDir(storage, raw)).meta).then(() => true, () => false);
}

export async function listCanvases(storage: string): Promise<CanvasMeta[]> {
  const names = await readdir(storage).catch(() => [] as string[]);
  const metas = await Promise.all(names.map(n => readJson<CanvasMeta | null>(join(storage, n, 'canvas.json'), null)));
  return metas.filter((m): m is CanvasMeta => !!m).sort((a, b) => a.name.localeCompare(b.name));
}

/** The canvas a project used last, so the tool and /canvas work without naming it. */
export async function lastCanvasFor(storage: string, project: string): Promise<string | undefined> {
  const last = await readJson<Record<string, string>>(join(storage, 'last.json'), {});
  return last[project];
}
export async function rememberCanvas(storage: string, project: string, name: string) {
  await mkdir(storage, { recursive: true });
  await withLock(storage, async () => {
    const last = await readJson<Record<string, string>>(join(storage, 'last.json'), {});
    if (last[project] === name) return;
    last[project] = name;
    await writeJsonAtomic(join(storage, 'last.json'), last);
  });
}

export const readManifest = (storage: string, name: string) => readJson<Manifest>(files(canvasDir(storage, name)).manifest, { frames: [] });
export const readComments = (storage: string, name: string) => readJson<Comment[]>(files(canvasDir(storage, name)).comments, []);

export function findFrame(manifest: Manifest, ref: string) {
  const byId = manifest.frames.find(f => f.id === ref);
  if (byId) return byId;
  const byTitle = manifest.frames.filter(f => f.title === ref);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) throw new CanvasError(`Several frames are titled "${ref}"; use the frame id.`);
  throw new CanvasError(`No frame "${ref}" on this canvas. Run list.`);
}

// ---------- frame folders ----------

const REFUSED = [
  { test: (n: string) => n === '.env' || n.startsWith('.env.'), why: 'environment file' },
  { test: (n: string) => /\.(pem|key|p12|pfx|crt)$/i.test(n) || /^id_(rsa|ed25519|ecdsa)/.test(n), why: 'key or certificate' },
  { test: (n: string) => /^(credentials|secrets?)(\.|$)/i.test(n), why: 'credentials file' },
  { test: (n: string) => /\.(sqlite3?|db)$/i.test(n), why: 'database' },
  { test: (n: string) => /\.map$/i.test(n), why: 'source map' },
  { test: (n: string) => n === 'node_modules' || n === '.git', why: 'project folder' },
  { test: (n: string) => n === 'package.json' || n === 'package-lock.json', why: 'project file' },
];

const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)); };

/** Everything that stops a folder becoming a frame, each with a fix. An empty list means it can be added. */
export async function checkFolder(folder: string, entry: string, storage: string): Promise<{ problems: Problem[]; files: string[]; bytes: number }> {
  const problems: Problem[] = [];
  const root = resolve(folder);
  const info = await lstat(root).catch(() => null);
  if (!info || !info.isDirectory()) return { problems: [{ problem: `${folder} is not a folder`, fix: 'Pass the folder holding the built page (for example dist/ or out/).' }], files: [], bytes: 0 };
  if (root === resolve(homedir()) || root === sep) problems.push({ problem: 'the folder is your home or the filesystem root', fix: 'Build the page into its own folder and add that.' });
  if (inside(resolve(storage), root) || inside(root, resolve(storage))) problems.push({ problem: 'the folder contains or is inside canvas storage', fix: 'Build the page into a folder of its own, outside canvas storage.' });
  const found: string[] = [];
  let bytes = 0;
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name), rel = relative(root, full);
      const refused = REFUSED.find(r => r.test(name));
      if (refused) { problems.push({ file: rel, problem: `${refused.why} is not allowed in a frame`, fix: 'Leave it out of the frame folder; frames hold only the built page and its assets.' }); continue; }
      const st = await lstat(full);
      if (st.isSymbolicLink()) { problems.push({ file: rel, problem: 'symbolic link', fix: 'Copy the real file into the folder instead of linking it.' }); continue; }
      if (st.isDirectory()) { await walk(full); continue; }
      if (!st.isFile()) continue;
      if (st.size > LIMITS.fileBytes) problems.push({ file: rel, problem: `file is larger than ${LIMITS.fileBytes / 1048576} MB`, fix: 'Compress it or leave it out.' });
      bytes += st.size; found.push(rel);
    }
  };
  await walk(root);
  if (found.length > LIMITS.files) problems.push({ problem: `more than ${LIMITS.files} files`, fix: 'Add only the built page, not the project.' });
  if (bytes > LIMITS.frameBytes) problems.push({ problem: `more than ${LIMITS.frameBytes / 1048576} MB in total`, fix: 'Leave out unused assets and compress media.' });
  const entryPath = entry.split(/[?#]/)[0];
  if (!entryPath || entryPath.startsWith('/') || entryPath.split('/').includes('..')) problems.push({ problem: `entry "${entry}" is not a relative path`, fix: 'Use a path inside the folder, such as index.html or index.html?variant=b.' });
  else if (!found.includes(entryPath.split('/').join(sep))) problems.push({ problem: `entry "${entryPath}" is not in the folder`, fix: 'Point entry at the page to open, such as index.html.' });
  return { problems, files: found, bytes };
}

async function digest(dir: string, list: string[]) {
  const hash = createHash('sha256');
  for (const rel of [...list].sort()) { hash.update(rel); hash.update('\0'); hash.update(await readFile(join(dir, rel))); hash.update('\0'); }
  return hash.digest('hex');
}

function frameHash(frame: Omit<Frame, 'hash' | 'updatedAt'>, filesDigest: string) {
  const { id, title, entry, width, height, x, y } = frame;
  return createHash('sha256').update(JSON.stringify({ id, title, entry, width, height, x, y, filesDigest })).digest('hex').slice(0, 12);
}

/** Copy into place through a temporary folder, so a frame is never half-replaced. */
async function copyFrame(folder: string, dest: string) {
  const temp = `${dest}.${randomBytes(4).toString('hex')}.tmp`;
  await cp(resolve(folder), temp, { recursive: true, errorOnExist: false, force: true, verbatimSymlinks: true });
  await rm(dest, { recursive: true, force: true });
  await rename(temp, dest);
}

// ---------- frames ----------

export type FrameInput = { folder: string; title: string; width: number; height: number; entry?: string; newRow?: boolean };
const GAP = 80;

function checkSize(width: number, height: number) {
  for (const [label, v] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(v) || v < 50 || v > 8000) throw new CanvasError(`${label} must be a whole number of pixels from 50 to 8000.`);
  }
}
const checkTitle = (title: string) => { const t = title.trim(); if (!t || t.length > 80) throw new CanvasError('A title needs 1 to 80 characters.'); return t; };

/** Where the next frame goes: after the last frame in its row, or at the start of a new row below everything. */
function place(frames: Frame[], newRow: boolean) {
  if (!frames.length) return { x: 0, y: 0 };
  const bottom = Math.max(...frames.map(f => f.y + f.height));
  if (newRow) return { x: 0, y: bottom + GAP };
  const rowY = Math.max(...frames.map(f => f.y));
  const row = frames.filter(f => f.y === rowY);
  return { x: Math.max(...row.map(f => f.x + f.width)) + GAP, y: rowY };
}

/** Adds several frames, all or none. Never rewrites existing frames, so concurrent adds both survive. */
export async function addFrames(storage: string, name: string, inputs: FrameInput[]): Promise<Frame[]> {
  if (!inputs.length) throw new CanvasError('Nothing to add.');
  const dir = canvasDir(storage, name);
  const prepared = [];
  for (const input of inputs) {
    const title = checkTitle(input.title);
    checkSize(input.width, input.height);
    const entry = input.entry?.trim() || 'index.html';
    const check = await checkFolder(input.folder, entry, storage);
    if (check.problems.length) throw new ProblemsError(check.problems.map(p => ({ ...p, problem: `${title}: ${p.problem}` })));
    prepared.push({ ...input, title, entry, check });
  }
  return withLock(dir, async () => {
    const manifest = await readManifest(storage, name);
    if (manifest.frames.length + prepared.length > LIMITS.frames) throw new CanvasError(`A canvas holds at most ${LIMITS.frames} frames.`);
    const titles = new Set(manifest.frames.map(f => f.title));
    for (const p of prepared) {
      if (titles.has(p.title)) throw new CanvasError(`A frame titled "${p.title}" exists. Use update to change it, or pick another title.`);
      titles.add(p.title);
    }
    const added: Frame[] = [];
    for (const p of prepared) {
      const id = newId();
      const at = place([...manifest.frames, ...added], !!p.newRow);
      await copyFrame(p.folder, frameDir(storage, name, id));
      const base = { id, title: p.title, entry: p.entry, width: p.width, height: p.height, x: at.x, y: at.y, source: resolve(p.folder) };
      added.push({ ...base, hash: frameHash(base, await digest(frameDir(storage, name, id), p.check.files)), updatedAt: new Date().toISOString() });
    }
    await writeJsonAtomic(files(dir).manifest, { frames: [...manifest.frames, ...added] });
    return added;
  });
}

type Change = { hash: string } & ({ kind: 'update'; folder: string; entry?: string; width?: number; height?: number; title?: string } | { kind: 'move'; x: number; y: number } | { kind: 'remove' });

/** Changes one frame if it still has the hash the caller read; otherwise refuses with the current frame. */
export async function changeFrame(storage: string, name: string, ref: string, change: Change): Promise<Frame | null> {
  const dir = canvasDir(storage, name);
  let check: Awaited<ReturnType<typeof checkFolder>> | undefined;
  if (change.kind === 'update') {
    const probe = findFrame(await readManifest(storage, name), ref);
    check = await checkFolder(change.folder, change.entry?.trim() || probe.entry, storage);
    if (check.problems.length) throw new ProblemsError(check.problems);
  }
  return withLock(dir, async () => {
    const manifest = await readManifest(storage, name);
    const frame = findFrame(manifest, ref);
    if (frame.hash !== change.hash) throw new StaleError(frame);
    const others = manifest.frames.filter(f => f.id !== frame.id);
    if (change.kind === 'remove') {
      await rm(frameDir(storage, name, frame.id), { recursive: true, force: true });
      await rm(shotPath(storage, name, frame.id), { force: true });
      await writeJsonAtomic(files(dir).manifest, { frames: others });
      const comments = await readComments(storage, name);
      await writeJsonAtomic(files(dir).comments, comments.filter(c => c.frame !== frame.id));
      return null;
    }
    let next = { ...frame };
    if (change.kind === 'move') {
      if (!Number.isFinite(change.x) || !Number.isFinite(change.y)) throw new CanvasError('x and y must be numbers.');
      next = { ...next, x: Math.round(change.x), y: Math.round(change.y) };
    } else {
      const title = change.title === undefined ? frame.title : checkTitle(change.title);
      if (title !== frame.title && others.some(f => f.title === title)) throw new CanvasError(`A frame titled "${title}" exists.`);
      const width = change.width ?? frame.width, height = change.height ?? frame.height;
      checkSize(width, height);
      await copyFrame(change.folder, frameDir(storage, name, frame.id));
      next = { ...next, title, width, height, entry: change.entry?.trim() || frame.entry, source: resolve(change.folder) };
    }
    const list = check?.files ?? await listFiles(frameDir(storage, name, frame.id));
    const { hash: _h, updatedAt: _u, ...base } = next;
    next = { ...next, hash: frameHash(base, await digest(frameDir(storage, name, frame.id), list)), updatedAt: new Date().toISOString() };
    await writeJsonAtomic(files(dir).manifest, { frames: manifest.frames.map(f => f.id === frame.id ? next : f) });
    return next;
  });
}

async function listFiles(root: string) {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  await walk(root).catch(() => {});
  return out;
}

// ---------- comments ----------

const checkText = (text: string) => {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) throw new CanvasError('A comment needs text.');
  if (t.length > LIMITS.commentChars) throw new CanvasError(`A comment holds at most ${LIMITS.commentChars} characters.`);
  return t;
};

export async function addComment(storage: string, name: string, input: { frame: string; x: number; y: number; text: string }) {
  const dir = canvasDir(storage, name);
  return withLock(dir, async () => {
    const frame = findFrame(await readManifest(storage, name), input.frame);
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new CanvasError('x and y must be numbers.');
    const now = new Date().toISOString();
    const comment: Comment = { id: newId(), frame: frame.id, x: Math.round(input.x), y: Math.round(input.y), text: checkText(input.text), state: 'open', createdAt: now, updatedAt: now };
    const comments = await readComments(storage, name);
    await writeJsonAtomic(files(dir).comments, [...comments, comment]);
    return comment;
  });
}

export async function changeComment(storage: string, name: string, id: string, change: { text?: string; state?: 'open' | 'resolved' } | 'delete') {
  const dir = canvasDir(storage, name);
  return withLock(dir, async () => {
    const comments = await readComments(storage, name);
    const comment = comments.find(c => c.id === id);
    if (!comment) throw new CanvasError(`No comment ${id}.`);
    if (change === 'delete') { await writeJsonAtomic(files(dir).comments, comments.filter(c => c.id !== id)); return null; }
    if (change.state !== undefined && change.state !== 'open' && change.state !== 'resolved') throw new CanvasError('state must be open or resolved.');
    const next = { ...comment, ...(change.text !== undefined ? { text: checkText(change.text) } : {}), ...(change.state ? { state: change.state } : {}), updatedAt: new Date().toISOString() };
    await writeJsonAtomic(files(dir).comments, comments.map(c => c.id === id ? next : c));
    return next;
  });
}

/** What a model last saw of a canvas's open comments, from the canvas messages still in its context. */
export function lastSentComments(contextEntries: readonly any[], name: string): { hash: string; open: string[] } | undefined {
  for (let i = contextEntries.length - 1; i >= 0; i--) {
    const e = contextEntries[i];
    if (e?.type !== 'custom_message' || e.customType !== COMMENTS_MESSAGE_TYPE) continue;
    const parts: any[] = Array.isArray(e.details?.canvases) ? e.details.canvases : [e.details];
    const part = parts.find(p => p?.canvas === name && typeof p.hash === 'string');
    if (part) return { hash: part.hash, open: Array.isArray(part.open) ? part.open : [] };
  }
  return undefined;
}

const openHash = (open: Comment[]) => createHash('sha256').update(JSON.stringify(open.map(c => [c.id, c.frame, c.x, c.y, c.text]))).digest('hex').slice(0, 12);

/** Describes one comment for a model or a draft: frame, point in frame pixels, text. */
export function describeComment(c: Comment, frames: Frame[], marker = '') {
  const frame = frames.find(f => f.id === c.frame);
  const where = frame ? `"${frame.title}" (${frame.id})` : `removed frame ${c.frame}`;
  const outside = frame && (c.x > frame.width || c.y > frame.height) ? ' [outside the frame since it was resized]' : '';
  return `- ${marker}${where} at ${c.x},${c.y}${outside}: ${c.text.replace(/\n/g, '\n  ')}`;
}

/** The message announcing changed comments, or nothing when the model already has this version. */
export function commentsUpdate(name: string, comments: Comment[], frames: Frame[], last: { hash: string; open: string[] } | undefined) {
  const open = comments.filter(c => c.state === 'open');
  const hash = openHash(open);
  if (last?.hash === hash) return undefined;
  if (!last && !open.length) return undefined;
  const before = new Set(last?.open ?? []);
  const nowOpen = new Set(open.map(c => c.id));
  const closed = [...before].filter(id => !nowOpen.has(id));
  const lines = [`Canvas "${name}" comments changed. Open comments (positions are in the frame's own pixels):`];
  if (open.length) lines.push(...open.map(c => describeComment(c, frames, before.has(c.id) ? '' : 'NEW ')));
  else lines.push('- none');
  if (closed.length) lines.push(`Resolved or deleted since last time: ${closed.length}.`);
  return { customType: COMMENTS_MESSAGE_TYPE, content: lines.join('\n'), display: false, details: { canvas: name, hash, open: [...nowOpen] } };
}

export function statusText(frames: number, openComments: number) {
  if (!frames && !openComments) return '🖼 Canvas · empty';
  return `🖼 Canvas · ${frames} frame${frames === 1 ? '' : 's'} · ${openComments} comment${openComments === 1 ? '' : 's'}`;
}

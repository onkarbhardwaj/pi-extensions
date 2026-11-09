import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  CanvasError, ProblemsError, StaleError, addFrames, canvasExists, canvasName, canvasUrl, changeFrame, commentsUpdate,
  describeComment, ensureCanvas, findFrame, frameOrigin, lastCanvasFor, lastSentComments, listCanvases, loadConfig,
  readComments, readManifest, rememberCanvas, shotPath, statusText, type CanvasConfig, type Frame,
} from './core.ts';
import { ensureServer, type Host } from './server.ts';
import { screenshot, show } from './browser.ts';
import { GUIDE } from './guide.ts';

/** Chips shared with busywork's indicator row through Pi's event bus; see busywork's README. */
const CHIP_ID = 'canvas';

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
  let config: CanvasConfig | undefined;
  let configError: string | undefined;
  let host: Host | undefined;
  let context: any;
  let chipRow = false;
  const used = new Set<string>();

  const loadSettings = async () => {
    try { config = await loadConfig(join(agentDir, 'canvas.json'), agentDir); configError = undefined; }
    catch (error) { configError = error instanceof Error ? error.message : String(error); config = undefined; }
    return config;
  };
  const settings = () => { if (!config) throw new CanvasError(configError ?? 'Canvas settings are not loaded.'); return config; };

  /** Host the machine's canvas server, or use the one another session hosts. Only when needed; no polling. */
  const server = async () => {
    const c = settings();
    if (host?.hosting) return host;
    host = await ensureServer(c.storage, c.port, version);
    return host;
  };

  /** The canvas a call means: the one named, else the last one used from this project, else one named after the folder. */
  const resolveCanvas = async (raw: string | undefined, cwd: string, create: boolean) => {
    const c = settings();
    const name = raw ? canvasName(raw) : (await lastCanvasFor(c.storage, cwd)) ?? canvasName(basename(cwd) || 'canvas');
    if (!(await canvasExists(c.storage, name))) {
      if (!create) throw new CanvasError(`No canvas "${name}" yet. Add a frame to create it.`);
      await ensureCanvas(c.storage, name, cwd);
    }
    await rememberCanvas(c.storage, cwd, name);
    used.add(name);
    return name;
  };

  // ---------- indicator ----------

  async function refreshChip() {
    if (!context || !config) return;
    let label = '🖼 Canvas';
    try {
      const name = await lastCanvasFor(config.storage, context.cwd);
      if (name && await canvasExists(config.storage, name)) {
        const [manifest, comments] = await Promise.all([readManifest(config.storage, name), readComments(config.storage, name)]);
        label = statusText(manifest.frames.length, comments.filter(c => c.state === 'open').length);
      }
    } catch { label = '🖼 Canvas error'; }
    if (configError) label = '🖼 Canvas settings error';
    if (chipRow) { context.ui.setStatus?.(CHIP_ID, undefined); pi.events.emit('chips:set', { id: CHIP_ID, label, tone: 'canvas' }); }
    else context.ui.setStatus?.(CHIP_ID, label);
  }

  // busywork answers chips:hello with chips:ready, and asks again on its own session start.
  pi.events.on('chips:ready', () => { chipRow = true; void refreshChip(); });
  pi.events.on('chips:click', (data: any) => { if (data?.id === CHIP_ID && context) void openCanvas(context).catch(error => context.ui.notify(String(error?.message ?? error), 'error')); });

  // ---------- actions ----------

  async function openCanvas(ctx: any, raw?: string, fit: string[] = []) {
    const c = settings();
    const name = await resolveCanvas(raw, ctx.cwd, true);
    const h = await server();
    const url = canvasUrl(h.port, name);
    if (c.browser.cdp) {
      try { await show(c.browser.cdp, url, fit); ctx.ui.notify(`Canvas "${name}" is open in the browser.`, 'info'); return { url, opened: true }; }
      catch (error) { ctx.ui.notify(`${error instanceof Error ? error.message : String(error)} Canvas: ${url}`, 'warning'); return { url, opened: false }; }
    }
    ctx.ui.notify(`Canvas "${name}": ${url}`, 'info');
    return { url, opened: false };
  }

  async function shoot(name: string, frame: Frame) {
    const c = settings();
    if (!c.browser.cdp) return { path: null as string | null, image: null as string | null, note: 'No browser configured (browser.cdp in ~/.pi/agent/canvas.json), so no screenshot; check the frame in the canvas.' };
    const h = await server();
    try {
      const png = await screenshot(c.browser.cdp, `${frameOrigin(h.port, name, frame.id)}/${frame.entry}`, frame.width, frame.height);
      const path = shotPath(c.storage, name, frame.id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, png);
      return { path, image: png.toString('base64'), note: undefined };
    } catch (error) {
      return { path: null, image: null, note: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  const summary = (name: string, frame: Frame, port: number) => ({
    id: frame.id, title: frame.title, hash: frame.hash, width: frame.width, height: frame.height, x: frame.x, y: frame.y,
    entry: frame.entry, source: frame.source, url: `${frameOrigin(port, name, frame.id)}/${frame.entry}`,
  });

  const result = (value: unknown, images: string[] = []) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...images.map(data => ({ type: 'image' as const, data, mimeType: 'image/png' }))],
    details: value,
  });

  // ---------- tool ----------

  const frameItem = Type.Object({
    folder: Type.String({ description: 'Folder holding the built page (static files only).' }),
    title: Type.String({ description: 'Short, unique title on this canvas, e.g. "Todo · compact".' }),
    width: Type.Integer({ description: 'The design\'s real width in pixels, e.g. 390 for a phone, 1280 for desktop.' }),
    height: Type.Integer({ description: 'The design\'s real height in pixels.' }),
    entry: Type.Optional(Type.String({ description: 'Page to open inside the folder; default index.html. May carry a query, e.g. index.html?variant=b.' })),
    newRow: Type.Optional(Type.Boolean({ description: 'Start a new row with this frame.' })),
  }, { additionalProperties: false });

  pi.registerTool({
    name: 'canvas',
    label: 'Canvas',
    description: 'Lay out versions of a design as live frames on a canvas the person views in a browser, and read their comments. A frame is a folder of static files with no server or network. Call guide once before building your first frame. Use update, not remove and add, to change a version. Use show only when the person asks to see something.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('guide'), Type.Literal('add'), Type.Literal('update'), Type.Literal('move'), Type.Literal('remove'),
        Type.Literal('list'), Type.Literal('screenshot'), Type.Literal('show'), Type.Literal('comments'), Type.Literal('canvases'),
      ]),
      canvas: Type.Optional(Type.String({ description: 'Canvas name; default: the last one used from this project, or one named after the project folder.' })),
      frames: Type.Optional(Type.Array(frameItem, { description: 'For add: the frames to add, all or none.', minItems: 1, maxItems: 20 })),
      frame: Type.Optional(Type.String({ description: 'For update, move, remove, screenshot: frame id or exact title.' })),
      hash: Type.Optional(Type.String({ description: 'For update, move, remove: the frame hash from add or list; refused if the frame changed since.' })),
      folder: Type.Optional(Type.String({ description: 'For update: folder with the new build.' })),
      title: Type.Optional(Type.String({ description: 'For update: new title.' })),
      entry: Type.Optional(Type.String({ description: 'For update: new entry page.' })),
      width: Type.Optional(Type.Integer({ description: 'For update: new width.' })),
      height: Type.Optional(Type.Integer({ description: 'For update: new height.' })),
      x: Type.Optional(Type.Number({ description: 'For move: canvas position.' })),
      y: Type.Optional(Type.Number({ description: 'For move: canvas position.' })),
      show: Type.Optional(Type.Array(Type.String(), { description: 'For show: frame ids or titles to fit; default all.' })),
      includeResolved: Type.Optional(Type.Boolean({ description: 'For comments: include resolved comments.' })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      context = ctx;
      await loadSettings();
      const c = settings();
      try {
        if (params.action === 'guide') return result({ guide: GUIDE });
        if (params.action === 'canvases') return result({ canvases: await listCanvases(c.storage) });

        const name = await resolveCanvas(params.canvas, ctx.cwd, params.action === 'add' || params.action === 'show');
        const h = await server();

        if (params.action === 'add') {
          if (!params.frames?.length) throw new CanvasError('add needs frames: [{ folder, title, width, height }].');
          const added = await addFrames(c.storage, name, params.frames);
          const shots = [] as { title: string; path: string | null; note?: string; image: string | null }[];
          for (const frame of added) shots.push({ title: frame.title, ...(await shoot(name, frame)) });
          await refreshChip();
          return result({
            canvas: name, canvasUrl: canvasUrl(h.port, name),
            added: added.map(f => summary(name, f, h.port)),
            screenshots: shots.map(s => ({ title: s.title, path: s.path, note: s.note })),
            next: 'Look at each screenshot and check it shows the design you meant.',
          }, shots.map(s => s.image).filter((x): x is string => !!x));
        }
        if (params.action === 'list') {
          const [manifest, comments] = await Promise.all([readManifest(c.storage, name), readComments(c.storage, name)]);
          return result({
            canvas: name, canvasUrl: canvasUrl(h.port, name),
            frames: manifest.frames.map(f => ({ ...summary(name, f, h.port), openComments: comments.filter(x => x.frame === f.id && x.state === 'open').length })),
          });
        }
        if (params.action === 'comments') {
          const [manifest, comments] = await Promise.all([readManifest(c.storage, name), readComments(c.storage, name)]);
          let chosen = params.includeResolved ? comments : comments.filter(x => x.state === 'open');
          if (params.frame) { const f = findFrame(manifest, params.frame); chosen = chosen.filter(x => x.frame === f.id); }
          return result({ canvas: name, comments: chosen.map(x => ({ ...x, frameTitle: manifest.frames.find(f => f.id === x.frame)?.title ?? null })) });
        }
        if (params.action === 'show') {
          const opened = await openCanvas(ctx, name, params.show ?? []);
          return result({ canvas: name, ...opened });
        }
        if (!params.frame) throw new CanvasError(`${params.action} needs frame (id or exact title).`);
        if (params.action === 'screenshot') {
          const frame = findFrame(await readManifest(c.storage, name), params.frame);
          const shot = await shoot(name, frame);
          return result({ canvas: name, frame: frame.id, path: shot.path, note: shot.note }, shot.image ? [shot.image] : []);
        }
        if (!params.hash) throw new CanvasError(`${params.action} needs the frame's hash from add or list.`);
        if (params.action === 'update') {
          if (!params.folder) throw new CanvasError('update needs folder.');
          const frame = await changeFrame(c.storage, name, params.frame, { kind: 'update', hash: params.hash, folder: params.folder, entry: params.entry, title: params.title, width: params.width, height: params.height });
          const shot = await shoot(name, frame!);
          await refreshChip();
          return result({ canvas: name, updated: summary(name, frame!, h.port), screenshot: shot.path, note: shot.note ?? 'Comments on this frame were kept.' }, shot.image ? [shot.image] : []);
        }
        if (params.action === 'move') {
          if (params.x === undefined || params.y === undefined) throw new CanvasError('move needs x and y.');
          const frame = await changeFrame(c.storage, name, params.frame, { kind: 'move', hash: params.hash, x: params.x, y: params.y });
          return result({ canvas: name, moved: summary(name, frame!, h.port) });
        }
        await changeFrame(c.storage, name, params.frame, { kind: 'remove', hash: params.hash });
        await refreshChip();
        return result({ canvas: name, removed: params.frame });
      } catch (error) {
        if (error instanceof ProblemsError) return { ...result({ ok: false, problems: error.problems }), isError: true };
        if (error instanceof StaleError) return { ...result({ ok: false, error: error.message, current: { id: error.current.id, hash: error.current.hash } }), isError: true };
        throw error;
      }
    },
  });

  // ---------- command ----------

  pi.registerCommand('canvas', {
    description: 'Open the canvas; "/canvas <name>" opens another; "/canvas comments" puts open comments into the editor draft.',
    handler: async (args: string, ctx: any) => {
      context = ctx;
      try {
        await loadSettings();
        const word = (args ?? '').trim();
        if (word === 'comments') return await commentsToDraft(ctx);
        await openCanvas(ctx, word || undefined);
        await refreshChip();
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    },
  });

  /** Review mode: open comments go into the editor draft; nothing is sent. */
  async function commentsToDraft(ctx: any) {
    const c = settings();
    const name = await resolveCanvas(undefined, ctx.cwd, false);
    const [manifest, comments] = await Promise.all([readManifest(c.storage, name), readComments(c.storage, name)]);
    const open = comments.filter(x => x.state === 'open');
    if (!open.length) { ctx.ui.notify('No open comments on the canvas.', 'info'); return; }
    const text = [`Comments on canvas "${name}" (positions in frame pixels):`, ...open.map(x => describeComment(x, manifest.frames))].join('\n');
    const draft = ctx.ui.getEditorText?.() ?? '';
    ctx.ui.setEditorText?.(draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${text}` : text);
    ctx.ui.notify(`${open.length} comment${open.length === 1 ? '' : 's'} added to the draft; nothing was sent.`, 'info');
  }

  // ---------- comments reach the model only when they change ----------

  pi.on('before_agent_start', async (_event, ctx: any) => {
    context = ctx;
    const c = await loadSettings();
    if (!c || c.comments !== 'live') return undefined;
    const last = await lastCanvasFor(c.storage, ctx.cwd).catch(() => undefined);
    if (last) used.add(last);
    const entries = ctx.sessionManager.buildContextEntries();
    const parts: string[] = []; const details: any[] = [];
    for (const name of used) {
      if (!(await canvasExists(c.storage, name))) continue;
      const [manifest, comments] = await Promise.all([readManifest(c.storage, name), readComments(c.storage, name)]);
      const update = commentsUpdate(name, comments, manifest.frames, lastSentComments(entries, name));
      if (update) { parts.push(update.content); details.push(update.details); }
    }
    if (!parts.length) return undefined;
    void refreshChip();
    // One message for every canvas that changed; lastSentComments reads each canvas's part from it.
    return { message: { customType: 'canvas-comments', content: parts.join('\n\n'), display: false, details: { canvases: details } } };
  });

  pi.on('session_start', async (_event, ctx: any) => {
    context = ctx;
    await loadSettings();
    pi.events.emit('chips:hello', { id: CHIP_ID });
    await refreshChip();
  });
  pi.on('agent_settled', () => { void refreshChip(); });
  pi.on('session_shutdown', async () => {
    if (chipRow) pi.events.emit('chips:remove', { id: CHIP_ID });
    context?.ui.setStatus?.(CHIP_ID, undefined);
    const h = host; host = undefined; context = undefined;
    await h?.close();
  });
}


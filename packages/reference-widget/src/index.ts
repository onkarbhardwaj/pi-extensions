import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { realpath } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { STATE_TYPE, addPath, commandPath, labels, readSnapshot, resolvePath, restore } from './core.ts';
import { reader } from './reader.ts';

export default function referenceWidget(pi: ExtensionAPI) {
  let paths: string[] = [], opened = false;
  let queue: Promise<unknown> = Promise.resolve();
  const notifyError = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');

  function widget(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('reference-widget', (_tui, theme) => {
      let regions: { x: number; width: number; path?: string; add?: boolean }[] = [];
      return {
        invalidate() { regions = []; },
        render(width: number) {
          if (width < 1) return [];
          const accent = (text: string) => theme.fg('accent', stripVTControlCharacters(text));
          regions = []; let line = accent(truncateToWidth('[+]', width));
          regions.push({ x: 0, width: visibleWidth(line), add: true });
          const names = labels(paths);
          for (let i = 0; i < paths.length; i++) {
            const reserve = i + 1 < paths.length ? visibleWidth(` [+${paths.length - i}]`) : 0;
            const available = width - visibleWidth(line) - reserve - 1;
            if (available < 7) {
              const tail = truncateToWidth(` [+${paths.length - i}]`, Math.max(0, width - visibleWidth(line)));
              regions.push({ x: visibleWidth(line), width: visibleWidth(tail) });line += accent(tail);break;
            }
            const label = truncateToWidth(names[i], Math.min(26, available - 4));
            const pill = ` [${label}]`;
            regions.push({ x: visibleWidth(line), width: visibleWidth(pill), path: paths[i] });line += accent(pill);
          }
          return [line];
        },
        handleMouse(event: any) {
          if (event.type !== 'click' || event.button !== 'left' || event.y !== 0) return;
          const hit = regions.find(r => event.x >= r.x && event.x < r.x + r.width);
          if (!hit) return;
          void openReader(ctx, hit.path, hit.add).catch(e => notifyError(ctx, e));
          return { handled: true };
        },
      };
    }, { placement: 'belowEditor' });
  }
  function refresh(ctx: ExtensionContext) { paths = restore(ctx.sessionManager.getEntries()); widget(ctx); }
  async function mutate(action: 'add' | 'remove', path: string, ctx: ExtensionContext) {
    const sessionId = ctx.sessionManager.getSessionId();
    const operation = queue.then(async () => {
      const resolved = action === 'add' ? await addPath(path, ctx.cwd) : await realpath(resolvePath(path, ctx.cwd)).catch(error => {
        if (error.code === 'ENOENT') return resolvePath(path, ctx.cwd);
        throw error;
      });
      if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error('Session changed before the reference update completed.');
      const current = restore(ctx.sessionManager.getEntries());
      const next = action === 'add' ? [...new Set([...current, resolved])] : current.filter(p => p !== resolved);
      if (JSON.stringify(next) !== JSON.stringify(current)) pi.appendEntry(STATE_TYPE, { version: 1, paths: next });
      paths = next; widget(ctx);
      const hasConversation = ctx.sessionManager.getEntries().some(e => e.type === 'message' && ['user', 'assistant'].includes(e.message.role));
      if (!ctx.sessionManager.getSessionFile() || !hasConversation) ctx.ui.notify('References are memory-only until this session has a saved conversation.', 'warning');
      return { path: resolved, references: next.map((path, i) => ({ path, label: labels(next)[i] })) };
    });
    queue = operation.catch(() => {});
    return operation;
  }
  async function openReader(ctx: ExtensionContext, selected?: string, add = false) {
    if (ctx.mode !== 'tui') { ctx.ui.notify('The reference reader requires interactive terminal mode.', 'warning'); return; }
    if (opened) return;
    opened = true;
    try {
      if (add) {
        const value = await ctx.ui.input('Add Markdown reference', 'Full or relative file path');
        if (value === undefined) return;
        selected = (await mutate('add', commandPath(value) ?? '', ctx)).path;
      }
      refresh(ctx);
      const files = await Promise.all(paths.map(readSnapshot));
      const result = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => reader(tui, theme, done, {
        files, selected,
        add: async path => readSnapshot((await mutate('add', commandPath(path) ?? '', ctx)).path),
        remove: async path => { await mutate('remove', path, ctx); },
        refresh: readSnapshot,
      }), { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%', anchor: 'center' } });
      if (result !== undefined) {
        const draft = ctx.ui.getEditorText();
        ctx.ui.setEditorText(draft ? draft + '\n\n' + result : result);
      }
    } finally { opened = false; }
  }

  pi.on('session_start', (_event, ctx) => { try { refresh(ctx); } catch (e) { notifyError(ctx, e); } });
  pi.on('session_tree', (_event, ctx) => { try { refresh(ctx); } catch (e) { notifyError(ctx, e); } });
  pi.registerCommand('ref', {
    description: 'Add a Markdown reference: /ref <path>. With no path, open all references for reading and comments.',
    handler: async (args, ctx) => {
      try {
        const path = commandPath(args);
        if (path === undefined) await openReader(ctx);
        else { const result = await mutate('add', path, ctx); ctx.ui.notify(`Reference added: ${labels([result.path])[0]}`, 'info'); }
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerCommand('refs', {
    description: 'List this session’s registered reference files without opening the reader.',
    handler: async (_args, ctx) => {
      try {
        refresh(ctx); const names = labels(paths);
        ctx.ui.notify(paths.length
          ? paths.map((path, i) => `${i + 1}. ${names[i]}\n   ${path}`).join('\n')
          : 'No reference files registered.', 'info');
      } catch (error) { notifyError(ctx, error); }
    },
  });
  pi.registerTool({
    name: 'reference_widget', label: 'Reference files',
    description: 'Manage session Markdown references: add, list, or remove. Adding updates a filename bar without opening the reader or sending file contents to the model. Paths resolve against the current working directory. Remove unregisters a reference, never deletes its file. No comments are sent automatically.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('add'), Type.Literal('list'), Type.Literal('remove')]), path: Type.Optional(Type.String({ minLength: 1, description: 'File path required for add/remove; use a listed full path to remove an unavailable file.' })) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === 'list') {
        if (params.path !== undefined) throw new Error('List does not accept a path.');
        refresh(ctx); const names = labels(paths);
        const result = { references: paths.map((path, i) => ({ path, label: names[i] })) };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      }
      if (!params.path) throw new Error('A path is required for add/remove.');
      const result = await mutate(params.action, params.path, ctx);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

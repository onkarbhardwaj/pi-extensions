import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { execFile } from 'node:child_process';
import { unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';
import { frame } from './frame.ts';
import { pageToward, scrollbar } from './scrollbar.ts';
import { type Config, type StatusResult, fetchStatus, loadConfig, notableChange } from './github.ts';
import { type Entry, type EntryChanges, type Queue, addEntry, parseRef, readQueue, removeEntry, updateEntry, updateQueue } from './queue.ts';
import { SECTION_TITLE, TITLE_MAX, chipLabel, detailParts, group, refText, statusParts, updatedText } from './view.ts';

const CHIP_ID = 'pr-queue';
const POLL_MS = 5 * 60_000;
const PARALLEL = 4;

export default async function (pi: ExtensionAPI) {
  const queueFile = join(getAgentDir(), 'pr-queue', 'queue.json');
  let config: Config = { ci: {} };
  let configError: string | undefined;
  try { config = await loadConfig(join(getAgentDir(), 'pr-queue.json')); }
  catch (error) { configError = `pr-queue.json: ${error instanceof Error ? error.message : String(error)}`; }

  let entries: Entry[] = [];
  let queueError: string | undefined;
  const statuses = new Map<string, StatusResult>();
  let lastChecked: number | undefined;
  let context: ExtensionContext | undefined;
  let chipRow = false;
  let watching = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> | undefined;
  let redraw: (() => void) | undefined;
  let panelOpen = false;

  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  function refreshChip() {
    const ui = context?.ui;
    if (!ui) return;
    const label = queueError ? '👀 queue error' : chipLabel(entries, statuses);
    if (chipRow) { ui.setStatus?.(CHIP_ID, undefined); pi.events.emit('chips:set', { id: CHIP_ID, label }); }
    else ui.setStatus?.(CHIP_ID, label);
  }

  const changed = () => { refreshChip(); try { redraw?.(); } catch {} };

  async function reload() {
    try { entries = (await readQueue(queueFile)).entries; queueError = undefined; }
    catch (error) { queueError = message(error); }
    const ids = new Set(entries.map(entry => entry.id));
    for (const id of statuses.keys()) if (!ids.has(id)) statuses.delete(id);
    changed();
  }

  async function check(targets: Entry[]) {
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const entry = targets[next++];
        const before = statuses.get(entry.id)?.status;
        try {
          const status = await fetchStatus(entry, config);
          statuses.set(entry.id, { status, checkedAt: status.checkedAt });
          if (context) for (const text of notableChange(refText(entry), before, status)) context.ui.notify(text, 'warning');
        } catch (error) {
          // Keep the last known status; show the error only when there is nothing else.
          statuses.set(entry.id, { status: before, error: message(error), checkedAt: Date.now() });
        }
        changed();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, targets.length) }, worker));
  }

  /** Checks every PR, or only those never checked; at most one run at a time. */
  function poll(onlyNew = false): Promise<void> {
    if (polling) return polling;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    polling = (async () => {
      try {
        const targets = onlyNew ? entries.filter(entry => !statuses.has(entry.id)) : entries;
        await check(targets);
        if (!onlyNew) lastChecked = Date.now();
      } finally {
        polling = undefined;
        if (context) pollTimer = setTimeout(() => void poll(), POLL_MS);
        changed();
      }
    })();
    return polling;
  }

  async function mutate(change: (queue: Queue) => { queue: Queue; result: string }) {
    const result = await updateQueue(queueFile, change);
    await reload();
    void poll(true);
    return result;
  }

  function openUrl(url: string) {
    const [file, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    execFile(file as string, args as string[], error => { if (error) context?.ui.notify(`Could not open ${url}`, 'warning'); });
  }

  async function showPanel(ctx: ExtensionContext) {
    if (panelOpen || ctx.mode !== 'tui') return;
    panelOpen = true;
    try {
      await reload();
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const TOGGLE = '\u0000toggle:', OPEN = '\u0000open:', REMOVE = '\u0000remove:', DONE = '\u0000done', REFRESH = '\u0000refresh';
        const expanded = new Set<string>();
        let showDone = false, confirmRemove: string | undefined, focused: string | undefined;
        let scroll = 0, maxScroll = 0, revealFocus = false;
        let regions: { target?: string; x: number; y: number; width: number }[] = [];
        let track: { x: number; top: number; height: number; total: number } | undefined;
        let refreshing = false;
        redraw = () => tui.requestRender();

        const remove = async (id: string) => {
          try { await mutate(queue => ({ queue: removeEntry(queue, id), result: '' })); }
          catch (error) { ctx.ui.notify(message(error), 'error'); }
          expanded.delete(id); focused = undefined; tui.requestRender();
        };
        const activate = (target: string | undefined) => {
          if (target !== confirmRemove) confirmRemove = undefined;
          if (target === undefined) done();
          else if (target === REFRESH) {
            if (refreshing) return;
            refreshing = true; tui.requestRender();
            void reload().then(() => poll()).finally(() => { refreshing = false; tui.requestRender(); });
          } else if (target === DONE) { showDone = !showDone; tui.requestRender(); }
          else if (target.startsWith(TOGGLE)) {
            const id = target.slice(TOGGLE.length);
            if (!expanded.delete(id)) expanded.add(id);
            tui.requestRender();
          } else if (target.startsWith(OPEN)) {
            const entry = entries.find(item => item.id === target.slice(OPEN.length));
            if (entry) openUrl(entry.url);
          } else if (target.startsWith(REMOVE)) {
            // Removing cannot be undone, so it takes a second press.
            if (confirmRemove !== target) { confirmRemove = target; tui.requestRender(); return; }
            confirmRemove = undefined;
            void remove(target.slice(REMOVE.length));
          }
        };
        const visibleEntries = () => { const g = group(entries, statuses); return [...g.review, ...g.waiting, ...(showDone ? g.done : [])]; };
        const moveFocus = () => {
          const choices = [undefined, REFRESH, ...visibleEntries().flatMap(entry => [TOGGLE + entry.id, OPEN + entry.id, REMOVE + entry.id]),
            ...(group(entries, statuses).done.length ? [DONE] : [])];
          focused = choices[(choices.indexOf(focused) + 1) % choices.length];
          revealFocus = true;
          tui.requestRender();
        };

        return frame({
          invalidate() { regions = []; },
          dispose() { redraw = undefined; },
          render(width: number) {
            const w = Math.max(1, width);
            const margin = w >= 8 ? 2 : 0;
            const contentWidth = Math.max(1, w - margin * 2);
            type Part = { text: string; style?: any; target?: string | null };
            const rows: Part[][] = [];
            const muted = { fg: 'muted' }, accent = { fg: 'accent' }, heading = { fg: 'mdHeading', bold: true };
            const starts = new Map<string, number>();
            const grouped = group(entries, statuses);

            const entryRows = (entry: Entry) => {
              const open = expanded.has(entry.id), result = statuses.get(entry.id);
              starts.set(entry.id, rows.length);
              const removeLabel = confirmRemove === REMOVE + entry.id ? '[✕ press again]' : '[✕]';
              // The title gives way first, so the status and the remove button stay visible.
              const fixed = visibleWidth(`▸ ${refText(entry)}: ${statusParts(result, 0).join(' · ')} · ${removeLabel}`) - 1;
              const titleMax = Math.max(1, Math.min(TITLE_MAX, contentWidth - fixed));
              rows.push([
                { text: open ? '▾ ' : '▸ ', style: accent, target: TOGGLE + entry.id },
                { text: refText(entry), style: { fg: 'mdLink', underline: true }, target: OPEN + entry.id },
                { text: ': ' + statusParts(result, titleMax).join(' · ') + ' · ' },
                { text: removeLabel, style: muted, target: REMOVE + entry.id },
              ]);
              if (!open) return;
              const indent = '    ', room = Math.max(1, contentWidth - indent.length);
              const details = detailParts(entry, result);
              if (details.length) rows.push([{ text: indent + details.join(' · '), style: muted }]);
              if (result?.status && result.error) rows.push([{ text: `${indent}⚠ Last check failed: ${result.error}`, style: { fg: 'warning' } }]);
              if (result?.status?.failedChecks.length) rows.push([{ text: `${indent}Failing: ${result.status.failedChecks.join(', ')}`, style: { fg: 'error' } }]);
              if (entry.note) for (const paragraph of entry.note.split('\n'))
                for (const line of paragraph.trim() ? wrapTextWithAnsi(paragraph, room) : ['']) rows.push([{ text: indent + line }]);
            };

            if (queueError) rows.push([{ text: `⚠ ${queueError}`, style: { fg: 'error' } }], []);
            if (configError) rows.push([{ text: `⚠ ${configError}`, style: { fg: 'warning' } }], []);
            for (const section of ['review', 'waiting'] as const) {
              const items = grouped[section];
              rows.push([{ text: `${SECTION_TITLE[section]} (${items.length})`, style: heading }], []);
              for (const entry of items) entryRows(entry);
              if (!items.length) rows.push([{ text: 'Nothing here.', style: muted }]);
              rows.push([]);
            }
            if (grouped.done.length) {
              rows.push([{ text: `${showDone ? '▾' : '▸'} Done (${grouped.done.length})`, style: heading, target: DONE }]);
              if (showDone) { rows.push([]); for (const entry of grouped.done) entryRows(entry); }
              rows.push([]);
            }

            const available = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 5);
            maxScroll = Math.max(0, rows.length - available);
            if (revealFocus && focused !== undefined) {
              const index = rows.findIndex(row => row.some(part => part.target === focused));
              if (index >= 0 && index < scroll) scroll = index;
              else if (index >= scroll + available) scroll = index - available + 1;
            }
            revealFocus = false;
            scroll = Math.max(0, Math.min(scroll, maxScroll));
            const footer: Part[] = [
              { text: updatedText(lastChecked), style: muted }, { text: ' · ', style: muted },
              { text: refreshing || polling ? 'Refreshing…' : 'Refresh', style: muted, target: refreshing ? '\u0000busy' : REFRESH },
              { text: ' · ', style: muted }, { text: 'Close', style: muted, target: null },
            ];
            const display: Part[][] = [[], ...rows.slice(scroll, scroll + available), footer,
              [{ text: 'Tab: choose · Enter: select · ↑↓/wheel: scroll · Esc: close', style: muted }]];
            const bg = theme.colors.toolPendingBg, fg = theme.colors.text, selectedBg = theme.colors.userMessageBg;
            regions = [];
            const bar = margin >= 2 ? scrollbar(available, rows.length, scroll) : undefined;
            track = bar ? { x: w - 2, top: 1, height: available, total: rows.length } : undefined;
            return display.map((row, y) => {
              let out = theme.style(' '.repeat(margin), { bg }), x = margin;
              for (const part of row) {
                const room = margin + contentWidth - x;
                if (room <= 0) break;
                const clipped = truncateToWidth(part.text, room), size = visibleWidth(clipped);
                const clickable = part.target !== undefined && part.target !== '\u0000busy';
                const target = part.target === null ? undefined : part.target;
                if (clickable) regions.push({ target, x, y, width: size });
                const active = clickable && target === focused;
                out += theme.style(clipped, { fg, bg, ...part.style, ...(active ? { fg, bg: selectedBg, bold: true } : {}) });
                x += size;
              }
              const thumb = bar?.[y - 1];
              if (thumb === undefined) return out + theme.style(' '.repeat(Math.max(0, w - x)), { bg });
              return out + theme.style(' '.repeat(Math.max(0, w - 2 - x)), { bg })
                + theme.style(thumb ? '┃' : '│', { fg: thumb ? 'scrollbarThumb' : 'scrollbarTrack', bg }) + theme.style(' ', { bg });
            });
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape)) done();
            else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) moveFocus();
            else if (matchesKey(data, Key.up)) { scroll = Math.max(0, scroll - 1); tui.requestRender(); }
            else if (matchesKey(data, Key.down)) { scroll = Math.min(maxScroll, scroll + 1); tui.requestRender(); }
            else if (matchesKey(data, Key.enter)) activate(focused);
          },
          handleMouse(event: any) {
            if (event.type === 'wheel') {
              scroll = Math.max(0, Math.min(maxScroll, scroll + (event.wheelDelta ?? 0)));
              tui.requestRender(); return { handled: true };
            }
            if (event.type !== 'click' || event.button !== 'left') return;
            if (track && event.x === track.x && event.y >= track.top && event.y < track.top + track.height) {
              scroll = pageToward(event.y - track.top, track.height, track.total, scroll);
              tui.requestRender(); return { handled: true };
            }
            const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
            if (!hit) return;
            activate(hit.target);
            return { handled: true };
          },
        }, theme);
      }, { overlay: true, overlayOptions: { width: '75%', maxHeight: '80%', anchor: 'center' } });
    } finally { panelOpen = false; redraw = undefined; }
  }

  // busywork answers chips:hello with chips:ready, and asks again on its own session start.
  pi.events.on('chips:ready', () => { chipRow = true; refreshChip(); });
  pi.events.on('chips:click', (data: any) => {
    if (data?.id === CHIP_ID && context) void showPanel(context).catch(error => context?.ui.notify(message(error), 'error'));
  });

  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    if (ctx.mode !== 'tui') return;
    pi.events.emit('chips:hello', { id: CHIP_ID });
    await reload();
    if (!watching) { watching = true; watchFile(queueFile, { interval: 2000 }, () => void reload().then(() => poll(true))); }
    void poll();
  });
  pi.on('session_shutdown', () => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (watching) unwatchFile(queueFile);
    watching = false;
    if (chipRow) pi.events.emit('chips:remove', { id: CHIP_ID });
    context?.ui.setStatus?.(CHIP_ID, undefined);
    context = undefined;
  });

  const changesFrom = (params: any): EntryChanges => ({
    ...(params.section !== undefined ? { section: params.section } : {}),
    ...(params.priority !== undefined ? { priority: params.priority === 'none' ? null : params.priority } : {}),
    ...(params.note !== undefined ? { note: params.note } : {}),
    ...(params.addedBy !== undefined ? { addedBy: params.addedBy } : {}),
  });

  pi.registerTool({
    name: 'pr_queue',
    label: 'PR review queue',
    description: 'Manage the shared PR review queue that every Pi session shows in a chip. '
      + 'add puts a pull request in the queue (or updates it if already queued); update changes its section, priority or note; '
      + 'remove takes it out; list returns entries with their last known GitHub status. '
      + 'section "review" means it needs the user\'s review; "waiting" means it is waiting on someone else. '
      + 'The note is free text shown when the PR is expanded, e.g. why it matters and links to relevant discussion. '
      + 'Approved, merged and closed PRs move to Done automatically; they are never removed unless asked.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('add'), Type.Literal('update'), Type.Literal('remove')]),
      pr: Type.Optional(Type.String({ description: 'Required except for list. PR URL, or owner/repo#123 (host/owner/repo#123 for GitHub Enterprise).' })),
      section: Type.Optional(Type.Union([Type.Literal('review'), Type.Literal('waiting')], { description: 'For add/update. Defaults to review on add.' })),
      priority: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low'), Type.Literal('none')], { description: 'For add/update; none clears it.' })),
      note: Type.Optional(Type.String({ maxLength: 4000, description: 'For add/update. Replaces the note; an empty string clears it.' })),
      addedBy: Type.Optional(Type.String({ maxLength: 60, description: 'For add/update: the name of the agent or person adding the PR.' })),
    }, { additionalProperties: false }),
    async execute(_id, params: any) {
      if (params.action === 'list') {
        const queue = await readQueue(queueFile);
        const list = queue.entries.map(entry => ({ ...entry, status: statuses.get(entry.id)?.status, error: statuses.get(entry.id)?.error }));
        return { content: [{ type: 'text', text: JSON.stringify({ entries: list }) }], details: { action: 'list', entries: list } };
      }
      if (!params.pr) throw new Error(`pr is required for ${params.action}.`);
      const ref = parseRef(params.pr);
      const changes = changesFrom(params);
      const text = await mutate(queue => {
        if (params.action === 'remove') return { queue: removeEntry(queue, ref.id), result: `Removed ${ref.id}.` };
        if (params.action === 'update') return { queue: updateEntry(queue, ref, changes).queue, result: `Updated ${ref.id}.` };
        const result = addEntry(queue, ref, changes);
        return { queue: result.queue, result: result.added ? `Added ${ref.id}.` : `${ref.id} was already queued; updated it.` };
      });
      return { content: [{ type: 'text', text }], details: { action: params.action, id: ref.id } };
    },
  });

  pi.registerCommand('prq', {
    description: 'Open the PR review queue.',
    handler: async (_args, ctx) => {
      context ??= ctx;
      try { await showPanel(ctx); } catch (error) { ctx.ui.notify(message(error), 'error'); }
    },
  });
}

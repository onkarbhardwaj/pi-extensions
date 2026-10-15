import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { frame } from './frame.ts';
import { STATE_TYPE, type Reminder, describe, markDue, markMissed, nextDue, parseRemind, parseWhen, restore, statusText, validateText } from './core.ts';

export default function (pi: ExtensionAPI) {
  let reminders: Reminder[] = [];
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stateError: string | undefined;
  let panelOpen = false;
  let notifiedDue = new Set<string>();

  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const save = (next: Reminder[]) => {
    reminders = next;
    pi.appendEntry(STATE_TYPE, { version: 1, reminders });
    render();
    schedule();
  };
  const render = () => {
    if (!context || context.mode !== 'tui') return;
    const label = stateError ? '⏰ state error' : statusText(reminders);
    if (!label) { context.ui.setWidget('pi-reminders', undefined); return; }
    const ctx = context;
    ctx.ui.setWidget('pi-reminders', (_tui, theme) => ({
      invalidate() {},
      render(width: number) { return [truncateToWidth(theme.fg('accent', label), width)]; },
      handleMouse(event: any) {
        if (event.type !== 'click' || event.button !== 'left') return;
        void manage(ctx).catch(error => ctx.ui.notify(String(error), 'error'));
        return { handled: true, render: false };
      },
    }), { placement: 'belowEditor' });
  };

  function load(ctx: ExtensionContext, startup = false) {
    context = ctx;
    try {
      const restored = restore(ctx.sessionManager.getEntries());
      reminders = startup ? markMissed(restored) : restored;
      stateError = undefined;
      if (startup && reminders.some((r, i) => r.status !== restored[i].status)) pi.appendEntry(STATE_TYPE, { version: 1, reminders });
    } catch (error) {
      reminders = [];
      stateError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(stateError, 'error');
    }
    render();
    schedule();
  }

  function schedule() {
    clearTimer();
    if (!context || stateError) return;
    const next = nextDue(reminders);
    const attention = reminders.some(reminder => reminder.status !== 'scheduled' && !notifiedDue.has(reminder.id));
    if (!Number.isFinite(next) && !attention) return;
    const delay = attention ? 1000 : Math.max(0, Math.min(next - Date.now(), 2_147_483_647));
    timer = setTimeout(fire, delay);
  }

  function fire() {
    timer = undefined;
    if (!context) return;
    const updated = markDue(reminders);
    if (updated.some((reminder, i) => reminder.status !== reminders[i].status)) {
      reminders = updated;
      pi.appendEntry(STATE_TYPE, { version: 1, reminders });
      render();
    }
    if (!context.isIdle()) return schedule();
    const pending = reminders.filter(reminder => reminder.status !== 'scheduled' && !notifiedDue.has(reminder.id));
    for (const reminder of pending) notifiedDue.add(reminder.id);
    if (pending.length === 1) context.ui.notify(`Reminder: ${pending[0].text}`, 'info');
    else if (pending.length > 1) context.ui.notify(`${pending.length} reminders are due. Run /reminders.`, 'info');
    schedule();
  }

  function add(dueAt: number, text: string) {
    if (stateError) throw new Error(stateError);
    const reminder = { id: randomUUID(), text: validateText(text), dueAt, createdAt: Date.now(), status: 'scheduled' as const };
    save([...reminders, reminder].sort((a, b) => a.dueAt - b.dueAt));
    return reminder;
  }

  function remove(id: string) {
    if (stateError) throw new Error(stateError);
    const next = reminders.filter(reminder => reminder.id !== id);
    if (next.length === reminders.length) throw new Error('Reminder not found.');
    notifiedDue.delete(id);
    save(next);
  }

  async function manage(ctx: ExtensionContext) {
    if (panelOpen || ctx.mode !== 'tui') return;
    panelOpen = true;
    try {
      if (!reminders.length) { ctx.ui.notify('No reminders.', 'info'); return; }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let selected = 0, regions: any[] = [];
        const actions = () => reminders.flatMap(r => [{ id: r.id, action: 'dismiss' }, { id: r.id, action: 'snooze' }]).concat({ id: '', action: 'close' });
        const run = (target: any) => {
          if (target.action === 'close') return done();
          if (target.action === 'dismiss') remove(target.id);
          else {
            notifiedDue.delete(target.id);
            save(reminders.map(item => item.id === target.id ? { ...item, dueAt: parseWhen('15m'), status: 'scheduled' as const } : item).sort((a, b) => a.dueAt - b.dueAt));
          }
          selected = Math.min(selected, actions().length - 1);
          if (!reminders.length) done(); else tui.requestRender();
        };
        return frame({
          invalidate() { regions = []; },
          render(width) {
            const bg = theme.colors.toolPendingBg, fg = theme.colors.text, selectedBg = theme.colors.userMessageBg;
            const paint = (text: string, columns = width, options: any = {}) => {
              const clipped = truncateToWidth(text, Math.max(0, columns));
              return theme.style(clipped + ' '.repeat(Math.max(0, columns - visibleWidth(clipped))), { fg, bg, ...options });
            };
            const lines: string[] = [paint('Reminders', width, { bold: true }), paint('')];
            regions = [];
            let index = 0;
            const buttonRow = (buttons: [string, string, string][], suffix = '') => {
              let x = 0, plain = '';
              const spans: { x: number; width: number; selected: boolean }[] = [];
              for (const [label, action, id] of buttons) {
                const size = visibleWidth(label);
                regions.push({ x, y: lines.length, width: size, id, action, index });
                spans.push({ x, width: size, selected: index === selected });
                plain += label + ' · '; x += size + 3; index++;
              }
              plain = suffix ? plain + suffix : plain.slice(0, -3);
              const padded = truncateToWidth(plain, width) + ' '.repeat(Math.max(0, width - visibleWidth(truncateToWidth(plain, width))));
              let row = '', at = 0;
              for (const span of spans.filter(s => s.x < width)) {
                row += theme.style(sliceByColumn(padded, at, span.x - at), { fg, bg });
                row += theme.style(sliceByColumn(padded, span.x, Math.min(span.width, width - span.x)), { fg: 'muted', bg: span.selected ? selectedBg : bg, bold: span.selected });
                at = span.x + span.width;
              }
              lines.push(row + theme.style(sliceByColumn(padded, at, Math.max(0, width - at)), { fg, bg }));
            };
            for (const reminder of reminders) {
              lines.push(paint(`Reminder: ${reminder.text}`));
              const state = reminder.status === 'scheduled' ? 'Scheduled' : reminder.status === 'due' ? 'Due' : 'Missed';
              lines.push(paint(`${state} · ${new Date(reminder.dueAt).toLocaleString()}`));
              buttonRow([['Dismiss', 'dismiss', reminder.id], ['Snooze', 'snooze', reminder.id]]);
              lines.push(paint(''));
            }
            buttonRow([['Close', 'close', '']]);
            lines.push(paint('Tab/arrows: choose · Enter: select · Esc: close', width, { fg: 'muted' }));
            return lines;
          },
          handleInput(data) {
            const count = actions().length;
            if (matchesKey(data, Key.escape)) done();
            else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.down)) { selected = (selected + 1) % count; tui.requestRender(); }
            else if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) { selected = (selected + count - 1) % count; tui.requestRender(); }
            else if (matchesKey(data, Key.enter)) run(actions()[selected]);
          },
          handleMouse(event) {
            if (event.type !== 'click' || event.button !== 'left') return;
            const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
            if (!hit) return;
            selected = hit.index; run(hit); return { handled: true };
          },
        }, theme);
      }, { overlay: true, overlayOptions: { width: '70%', maxHeight: '80%', anchor: 'center' } });
    } finally { panelOpen = false; }
  }

  pi.on('session_start', (_event, ctx) => { notifiedDue = new Set(); load(ctx, true); });
  pi.on('session_tree', (_event, ctx) => load(ctx));
  pi.on('agent_settled', () => schedule());
  pi.on('session_shutdown', () => { clearTimer(); context?.ui.setWidget('pi-reminders', undefined); context = undefined; });

  pi.registerCommand('remind', {
    description: 'Schedule a session reminder: /remind <30m|2h|15:30|ISO date> <text>',
    handler: async (args, ctx) => {
      try {
        context = ctx;
        const parsed = parseRemind(args);
        const reminder = add(parsed.dueAt, parsed.text);
        ctx.ui.notify(`Reminder set for ${new Date(reminder.dueAt).toLocaleString()}.`, 'info');
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    },
  });
  pi.registerCommand('reminders', {
    description: 'Show reminders with one-click dismiss or 15-minute snooze.',
    handler: async (_args, ctx) => { context = ctx; await manage(ctx); },
  });
  pi.registerTool({
    name: 'reminder',
    label: 'Reminders',
    description: 'Manage this Pi session’s reminders. Add or remove only when the user asks. Reminders notify when due and Pi is idle; they do not wake the agent.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('add'), Type.Literal('remove')]),
      when: Type.Optional(Type.String({ description: 'For add: 30m, 2h, 15:30, or future ISO date.' })),
      text: Type.Optional(Type.String({ description: 'For add: reminder text.' })),
      id: Type.Optional(Type.String({ description: 'For remove: exact reminder ID.' })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      context = ctx;
      if (params.action === 'list') return { content: [{ type: 'text', text: JSON.stringify({ reminders }) }], details: { reminders } };
      if (params.action === 'add') {
        if (!params.when || params.id !== undefined) throw new Error('Add requires when and text only.');
        const reminder = add(parseWhen(params.when), validateText(params.text));
        return { content: [{ type: 'text', text: `Reminder ${reminder.id} set for ${new Date(reminder.dueAt).toISOString()}.` }], details: { reminder } };
      }
      if (!params.id || params.when !== undefined || params.text !== undefined) throw new Error('Remove requires id only.');
      remove(params.id);
      return { content: [{ type: 'text', text: `Removed reminder ${params.id}.` }], details: { id: params.id } };
    },
  });
}

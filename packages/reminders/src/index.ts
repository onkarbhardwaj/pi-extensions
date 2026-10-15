import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
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
  const render = () => context?.ui.setStatus('pi-reminders', stateError ? '⏰ state error' : statusText(reminders));

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
      const labels = reminders.map(describe);
      const choice = await ctx.ui.select('Reminders', labels);
      const reminder = reminders[labels.indexOf(choice ?? '')];
      if (!reminder) return;
      const action = await ctx.ui.select(reminder.text, [
        reminder.status === 'scheduled' ? 'Delete' : 'Dismiss', 'Snooze 10m', 'Snooze 1h', 'Close']);
      if (action === 'Delete' || action === 'Dismiss') remove(reminder.id);
      else if (action?.startsWith('Snooze')) {
        const dueAt = parseWhen(action.endsWith('10m') ? '10m' : '1h');
        notifiedDue.delete(reminder.id);
        save(reminders.map(item => item.id === reminder.id ? { ...item, dueAt, status: 'scheduled' as const } : item).sort((a, b) => a.dueAt - b.dueAt));
      }
    } finally { panelOpen = false; }
  }

  pi.on('session_start', (_event, ctx) => { notifiedDue = new Set(); load(ctx, true); });
  pi.on('session_tree', (_event, ctx) => load(ctx));
  pi.on('agent_settled', () => schedule());
  pi.on('session_shutdown', () => { clearTimer(); context?.ui.setStatus('pi-reminders', undefined); context = undefined; });

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
    description: 'Show, dismiss, snooze, or delete session reminders.',
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

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { frame } from './frame.ts';
import { HEARTBEAT_STATE_TYPE, type Heartbeat, dueHeartbeat, expire, heartbeatStatusText, heartbeatSummary, markRun, nextHeartbeat, parseHeartbeat, parseInterval, restoreHeartbeats, validateName, validatePrompt } from './heartbeats.ts';
import { STATE_TYPE, type Reminder, describe, markDue, markMissed, nextDue, parseRemind, parseWhen, restore, statusText, validateText } from './core.ts';

export default function (pi: ExtensionAPI) {
  let reminders: Reminder[] = [];
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stateError: string | undefined;
  let panelOpen = false;
  let notifiedDue = new Set<string>();
  let heartbeats: Heartbeat[] = [];
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatError: string | undefined;
  let runningHeartbeat: string | undefined;
  const expanded = new Set<string>();

  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const save = (next: Reminder[]) => {
    reminders = next;
    pi.appendEntry(STATE_TYPE, { version: 1, reminders });
    render();
    schedule();
  };
  const saveHeartbeats = (next: Heartbeat[]) => {
    heartbeats = next;
    pi.appendEntry(HEARTBEAT_STATE_TYPE, { version: 1, heartbeats });
    render();
    scheduleHeartbeat();
  };
  const render = () => {
    if (!context || context.mode !== 'tui') return;
    const reminderLabel = stateError ? '⏰ state error' : statusText(reminders) ?? '⏰ No reminders';
    const heartbeatLabel = heartbeatError ? '♥ state error' : heartbeatStatusText(heartbeats);
    if (!reminderLabel && !heartbeatLabel) { context.ui.setWidget('pi-reminders', undefined); return; }
    const ctx = context;
    const due = reminders.some(reminder => reminder.status !== 'scheduled');
    ctx.ui.setWidget('pi-reminders', (_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        const fg = theme.colors.text;
        const chips = [
          reminderLabel && theme.style(` ${reminderLabel} `, { fg, bg: theme.colors.userMessageBg, bold: due || !!stateError }),
          heartbeatLabel && theme.style(` ${heartbeatLabel} `, { fg, bg: theme.colors.toolSuccessBg, bold: !!heartbeatError }),
        ].filter(Boolean);
        return [truncateToWidth(chips.join(' '), width)];
      },
      handleMouse(event: any) {
        if (event.type !== 'click' || event.button !== 'left') return;
        const reminderWidth = reminderLabel ? visibleWidth(` ${reminderLabel} `) : 0;
        const section = reminderLabel && event.x < reminderWidth ? 'reminders' : heartbeatLabel && event.x >= (reminderLabel ? reminderWidth + 1 : 0) ? 'heartbeats' : undefined;
        if (!section) return;
        void manage(ctx, section).catch(error => ctx.ui.notify(String(error), 'error'));
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
    try {
      const restored = restoreHeartbeats(ctx.sessionManager.getEntries());
      heartbeats = expire(restored);
      heartbeatError = undefined;
      if (heartbeats.some((beat, i) => beat.status !== restored[i].status)) pi.appendEntry(HEARTBEAT_STATE_TYPE, { version: 1, heartbeats });
    } catch (error) {
      heartbeats = [];
      heartbeatError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(heartbeatError, 'error');
    }
    render();
    schedule();
    scheduleHeartbeat();
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    if (!context || heartbeatError || runningHeartbeat) return;
    const next = nextHeartbeat(heartbeats);
    if (!Number.isFinite(next)) return;
    heartbeatTimer = setTimeout(beat, Math.max(0, Math.min(next - Date.now(), 2_147_483_647)));
  }

  function beat() {
    heartbeatTimer = undefined;
    if (!context) return;
    const expired = expire(heartbeats);
    if (expired.some((beat, i) => beat.status !== heartbeats[i].status)) return saveHeartbeats(expired);
    const due = dueHeartbeat(heartbeats);
    if (!due) return scheduleHeartbeat();
    // Never interrupt: wait for idle, then run once even if several intervals were missed.
    if (!context.isIdle() || context.hasPendingMessages()) { heartbeatTimer = setTimeout(beat, 5000); return; }
    runningHeartbeat = due.id;
    saveHeartbeats(heartbeats.map(item => item.id === due.id ? markRun(item) : item));
    // sendUserMessage may return void; normalize both sync throws and async rejections.
    void Promise.resolve().then(() => pi.sendUserMessage(`[Heartbeat: ${due.name}]\n${due.prompt}`)).catch(error => {
      runningHeartbeat = undefined;
      context?.ui.notify(`Heartbeat ${due.name} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      scheduleHeartbeat();
    });
  }

  function addHeartbeat(input: { name: string; prompt: string; intervalMs: number; expiresAt?: number }) {
    if (heartbeatError) throw new Error(heartbeatError);
    const name = validateName(input.name);
    if (heartbeats.some(beat => beat.name === name)) throw new Error(`Heartbeat ${name} already exists.`);
    const now = Date.now();
    if (input.expiresAt !== undefined && input.expiresAt <= now) throw new Error('Heartbeat expiry must be in the future.');
    const heartbeat: Heartbeat = { id: randomUUID(), name, prompt: validatePrompt(input.prompt), intervalMs: input.intervalMs,
      nextAt: now + input.intervalMs, createdAt: now, expiresAt: input.expiresAt, status: 'active', runs: 0 };
    saveHeartbeats([...heartbeats, heartbeat]);
    return heartbeat;
  }

  function findHeartbeat(key: string) {
    const found = heartbeats.find(beat => beat.id === key || beat.name === key);
    if (!found) throw new Error('Heartbeat not found.');
    return found;
  }

  function setHeartbeat(key: string, action: 'pause' | 'resume' | 'stop') {
    if (heartbeatError) throw new Error(heartbeatError);
    const target = findHeartbeat(key);
    if (action === 'stop') { expanded.delete(target.id); return saveHeartbeats(heartbeats.filter(beat => beat.id !== target.id)); }
    if (target.status === 'expired') throw new Error('Expired heartbeats can only be stopped.');
    saveHeartbeats(heartbeats.map(beat => beat.id !== target.id ? beat : action === 'pause'
      ? { ...beat, status: 'paused' as const } : { ...beat, status: 'active' as const, nextAt: Math.max(beat.nextAt, Date.now()) }));
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

  async function manage(ctx: ExtensionContext, section: 'reminders' | 'heartbeats') {
    const showReminders = section === 'reminders', showHeartbeats = section === 'heartbeats';
    if (panelOpen || ctx.mode !== 'tui') return;
    panelOpen = true;
    try {
      if (showHeartbeats && !heartbeats.length) { ctx.ui.notify('No heartbeats.', 'info'); return; }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let selected = 0, regions: any[] = [];
        const actions = () => [
          ...(showReminders ? reminders : []).flatMap(r => [{ id: r.id, action: 'dismiss' }, { id: r.id, action: 'snooze' }]),
          ...(showHeartbeats ? heartbeats : []).flatMap(b => [{ id: b.id, action: 'expand' }, ...(b.status === 'expired' ? [] : [{ id: b.id, action: b.status === 'paused' ? 'resume' : 'pause' }]), { id: b.id, action: 'stop' }]),
          { id: '', action: 'close' },
        ];
        const run = (target: any) => {
          try {
          if (target.action === 'close') return done();
          if (target.action === 'expand') { if (!expanded.delete(target.id)) expanded.add(target.id); }
          else if (['pause', 'resume', 'stop'].includes(target.action)) setHeartbeat(target.id, target.action);
          else if (target.action === 'dismiss') remove(target.id);
          else {
            notifiedDue.delete(target.id);
            save(reminders.map(item => item.id === target.id ? { ...item, dueAt: parseWhen('15m'), status: 'scheduled' as const } : item).sort((a, b) => a.dueAt - b.dueAt));
          }
          } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
          selected = Math.min(selected, actions().length - 1);
          if (showHeartbeats && !heartbeats.length) done(); else tui.requestRender();
        };
        return frame({
          invalidate() { regions = []; },
          render(width) {
            const bg = theme.colors.toolPendingBg, fg = theme.colors.text, selectedBg = theme.colors.userMessageBg;
            const paint = (text: string, columns = width, options: any = {}) => {
              const clipped = truncateToWidth(text, Math.max(0, columns));
              return theme.style(clipped + ' '.repeat(Math.max(0, columns - visibleWidth(clipped))), { fg, bg, ...options });
            };
            const lines: string[] = [paint(showReminders ? 'Reminders' : 'Heartbeats', width, { bold: true }), paint('')];
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
            if (showReminders && !reminders.length) lines.push(paint('No reminders', width, { fg: 'muted' }), paint(''));
            for (const reminder of showReminders ? reminders : []) {
              lines.push(paint(`Reminder: ${reminder.text}`));
              const state = reminder.status === 'scheduled' ? 'Scheduled' : reminder.status === 'due' ? 'Due' : 'Missed';
              lines.push(paint(`${state} · ${new Date(reminder.dueAt).toLocaleString()}`));
              buttonRow([['Dismiss', 'dismiss', reminder.id], ['Snooze', 'snooze', reminder.id]]);
              lines.push(paint(''));
            }
            for (const heartbeat of showHeartbeats ? heartbeats : []) {
              const label = `Heartbeat: ${heartbeat.name}`;
              regions.push({ x: 0, y: lines.length, width: visibleWidth(label), id: heartbeat.id, action: 'expand', index });
              lines.push(paint(label, width, index++ === selected ? { bg: selectedBg, bold: true } : {}));
              lines.push(paint(heartbeatSummary(heartbeat)));
              if (expanded.has(heartbeat.id)) {
                for (const line of heartbeat.prompt.split('\n')) lines.push(paint(line, width, { fg: 'muted' }));
                if (heartbeat.lastResult) lines.push(paint(`Last result: ${heartbeat.lastResult}`, width, { fg: 'muted' }));
              }
              buttonRow([
                ...(heartbeat.status === 'expired' ? [] : [[heartbeat.status === 'paused' ? 'Resume' : 'Pause', heartbeat.status === 'paused' ? 'resume' : 'pause', heartbeat.id] as [string, string, string]]),
                ['Stop', 'stop', heartbeat.id],
              ]);
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
  pi.on('agent_end', event => {
    if (!runningHeartbeat) return;
    const id = runningHeartbeat;
    runningHeartbeat = undefined;
    const last = [...event.messages].reverse().find((message: any) => message.role === 'assistant') as any;
    const text = Array.isArray(last?.content) ? last.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(' ') : '';
    const lastResult = text.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
    if (heartbeats.some(beat => beat.id === id)) saveHeartbeats(heartbeats.map(beat => beat.id === id ? { ...beat, lastResult } : beat));
  });
  pi.on('agent_settled', () => { schedule(); scheduleHeartbeat(); });
  pi.on('session_shutdown', () => { clearTimer(); if (heartbeatTimer) clearTimeout(heartbeatTimer); heartbeatTimer = undefined; runningHeartbeat = undefined; context?.ui.setWidget('pi-reminders', undefined); context = undefined; });

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
    description: 'Show reminders.',
    handler: async (_args, ctx) => { context = ctx; await manage(ctx, 'reminders'); },
  });
  pi.registerCommand('heartbeat', {
    description: 'Run an agent instruction on an interval: /heartbeat <5m|1h> [until <11:30|2h>] <name> <instruction>',
    handler: async (args, ctx) => {
      try {
        context = ctx;
        const heartbeat = addHeartbeat(parseHeartbeat(args));
        ctx.ui.notify(`Heartbeat ${heartbeat.name} starts at ${new Date(heartbeat.nextAt).toLocaleTimeString()}.`, 'info');
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
    },
  });
  pi.registerCommand('heartbeats', {
    description: 'Show heartbeats.',
    handler: async (_args, ctx) => { context = ctx; await manage(ctx, 'heartbeats'); },
  });
  pi.registerTool({
    name: 'heartbeat',
    label: 'Heartbeats',
    description: 'Manage recurring agent instructions in this Pi session. Add, pause, resume, or stop only when the user asks. Heartbeats start agent turns only when Pi is idle.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('add'), Type.Literal('pause'), Type.Literal('resume'), Type.Literal('stop')]),
      name: Type.Optional(Type.String({ description: 'Heartbeat name. Required except for list.' })),
      every: Type.Optional(Type.String({ description: 'For add: interval such as 5m or 1h; minimum 5m.' })),
      until: Type.Optional(Type.String({ description: 'For add: optional expiry such as 2h, 11:30, or future ISO date.' })),
      instruction: Type.Optional(Type.String({ description: 'For add: instruction to send on each heartbeat.' })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      context = ctx;
      if (params.action === 'list') return { content: [{ type: 'text', text: JSON.stringify({ heartbeats }) }], details: { heartbeats } };
      if (!params.name) throw new Error('Heartbeat name is required.');
      if (params.action === 'add') {
        if (!params.every || !params.instruction) throw new Error('Add requires name, every, and instruction.');
        const heartbeat = addHeartbeat({ name: params.name, prompt: params.instruction, intervalMs: parseInterval(params.every), expiresAt: params.until ? parseWhen(params.until) : undefined });
        return { content: [{ type: 'text', text: `Heartbeat ${heartbeat.name} added.` }], details: { heartbeat } };
      }
      if (params.every !== undefined || params.until !== undefined || params.instruction !== undefined) throw new Error(`${params.action} accepts name only.`);
      setHeartbeat(params.name, params.action);
      return { content: [{ type: 'text', text: `Heartbeat ${params.name}: ${params.action}.` }], details: { name: params.name, action: params.action } };
    },
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

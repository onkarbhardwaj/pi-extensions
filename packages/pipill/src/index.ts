import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { reminderContext, toolDescription } from './guidance.ts';
import { hasRecentReminder } from './reminder.ts';
import { Key, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi, sliceByColumn, rgbColor } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { frame } from './frame.ts';
import { STATE_TYPE, parseArgs, toolCommand, restore, change, layout, ticketIds } from './core.ts';
import { type TicketStatus, currentBranch, currentRepo, describePr, fetchTicketPrs, icons, notableChanges, summarize } from './tickets.ts';

type Pill = { label: string; title?: string; description?: string };

export default async function (pi: ExtensionAPI) {
  const { ticketPrefixes, ci } = await loadConfig(join(getAgentDir(), 'pipill.json'));
  let pills: Pill[] = [];
  let stateError: string | undefined;
  let panelOpen = false;
  let sessionContext: ExtensionContext | undefined;
  const statuses = new Map<string, TicketStatus>();
  let repo: string | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const ticketOf = (pill: Pill) => ticketIds(pill.label, ticketPrefixes)[0];
  const POLL_MS = 3 * 60_000;

  async function pollTickets(ctx: ExtensionContext) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (polling || sessionContext !== ctx) return;
    polling = true;
    try {
      const tickets = [...new Set(pills.map(ticketOf).filter(Boolean))] as string[];
      if (tickets.length) {
        try { repo ??= await currentRepo(ctx.cwd); } catch { repo = undefined; }
        const ignore = (repo && ci[repo]?.ignore) || [];
        for (const ticket of tickets) {
          let next: TicketStatus;
          try { next = summarize(await fetchTicketPrs(ticket, ctx.cwd, ignore)); }
          catch (error) { next = { prs: statuses.get(ticket)?.prs ?? [], error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() }; }
          if (sessionContext !== ctx) return;
          for (const message of notableChanges(ticket, statuses.get(ticket), next)) ctx.ui.notify(message, 'warning');
          statuses.set(ticket, next);
        }
        showWidget(ctx);
      }
    } finally {
      polling = false;
      if (sessionContext === ctx) pollTimer = setTimeout(() => void pollTickets(ctx), POLL_MS);
    }
  }

  async function addBranchTicket(ctx: ExtensionContext) {
    const branch = await currentBranch(ctx.cwd);
    const ticket = branch && ticketIds(branch, ticketPrefixes)[0];
    if (!ticket || sessionContext !== ctx || stateError) return;
    if (pills.some(pill => ticketOf(pill) === ticket)) return;
    try { mutate(ctx, { action: 'add', pill: { label: ticket, title: `Current branch: ${branch}` } }, false); } catch {}
  }

  function openDiff(ctx: ExtensionContext, label: string) {
    const pill = pills.find(p => p.label === label);
    const ticket = pill && ticketOf(pill);
    const status = ticket ? statuses.get(ticket) : undefined;
    if (!ticket) return;
    if (!status) return ctx.ui.notify(`Still checking PRs for ${ticket}.`, 'info');
    const pr = status.prs.find(item => item.state === 'OPEN') ?? status.prs[0];
    if (!pr) return ctx.ui.notify(`No PR matched for ${ticket}.`, 'info');
    const request = { label: pr.branch, sessionId: ctx.sessionManager.getSessionId(), accepted: false };
    pi.events.emit('pi-diff-review:open', request);
    if (!request.accepted) ctx.ui.notify(`Diff review is unavailable. ${ticket}: ${pr.url}`, 'info');
  }

  function showWidget(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('pi-pills', (tui, theme) => {
      let regions: { action: string; label?: string; x: number; y: number; width: number }[] = [];
      return {
        invalidate() { regions = []; },
        render(width: number) {
          const result = layout(pills, width, visibleWidth, (s: string, w: number) => truncateToWidth(s, w),
            (pill: Pill) => { const ticket = ticketOf(pill); return ticket ? icons(statuses.get(ticket)) : undefined; });
          regions = result.regions;
          const dark = theme.appearance !== 'light';
          const fg = dark ? rgbColor(245, 220, 175) : rgbColor(80, 51, 18);
          return result.lines.map((line: string, y: number) => {
            let styled = '', column = 0;
            for (const region of result.blocks.filter(r => r.y === y)) {
              styled += ' '.repeat(region.x - column);
              styled += theme.style(sliceByColumn(line, region.x, region.width), { fg });
              column = region.x + region.width;
            }
            return styled;
          });
        },
        handleMouse(event: any) {
          if (event.type !== 'click' || event.button !== 'left') return;
          const hit = regions.find(r => event.y === r.y && event.x >= r.x && event.x < r.x + r.width);
          if (!hit) return;
          if (hit.action === 'diff') openDiff(ctx, hit.label!);
          else {
            void inspect(ctx, hit.action === 'inspect' ? hit.label : undefined).catch(e => ctx.ui.notify(String(e), 'error'));
          }
          return { handled: true, render: false };
        },
      };
    }, { placement: 'belowEditor' });
  }

  function refresh(ctx: ExtensionContext) {
    try { pills = restore(ctx.sessionManager.getEntries()); stateError = undefined; }
    catch (e) { pills = []; stateError = String(e); ctx.ui.notify(stateError, 'error'); }
    showWidget(ctx);
  }

  function mutate(ctx: ExtensionContext, command: any, notify = true) {
    // Read all entries again: tree navigation must not resurrect a removed pill.
    refresh(ctx);
    if (stateError) throw new Error(stateError);
    const result = change(pills, command, ticketPrefixes);
    let warning: string | undefined;
    if (result.changed) {
      pi.appendEntry(STATE_TYPE, { version: 1, pills: result.pills });
      pills = result.pills;
      showWidget(ctx);
      const hasConversation = ctx.sessionManager.getEntries().some(e => e.type === 'message' && ['user', 'assistant'].includes(e.message.role));
      if (!ctx.sessionManager.getSessionFile() || !hasConversation) {
        warning = 'Pills are memory-only until this session has a saved conversation. Ephemeral sessions cannot restore them.';
        if (notify) ctx.ui.notify(warning, 'warning');
      }
    }
    if (notify) ctx.ui.notify(result.message, 'info');
    return { ...result, pills: pills.map(p => ({ ...p })), warning };
  }

  async function inspect(ctx: ExtensionContext, label?: string) {
    if (panelOpen || ctx.mode !== 'tui') return;
    panelOpen = true;
    try {
      refresh(ctx);
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let scroll = 0, maxScroll = 0;
        let initialTarget = label;
        let focused: string | undefined; // Undefined means Close, the safe default.
        let revealFocus = false;
        let regions: { label?: string; x: number; y: number; width: number }[] = [];
        const remove = (target: string) => {
          mutate(ctx, { action: 'remove', label: target });
          focused = undefined;
          tui.requestRender();
        };
        const moveFocus = () => {
          const choices = [undefined, ...pills.map(p => p.label)];
          focused = choices[(choices.indexOf(focused) + 1) % choices.length];
          revealFocus = true;
          tui.requestRender();
        };
        return frame({
          invalidate() { regions = []; },
          render(width) {
            const w = Math.max(1, width);
            const margin = w >= 8 ? 2 : 0;
            const contentWidth = Math.max(1, w - margin * 2);
            const rows: { text: string; bold?: boolean; remove?: string; removeX?: number }[] = [];
            const starts = new Map<string, number>();
            for (const pill of pills) {
              starts.set(pill.label, rows.length);
              if (contentWidth >= 14) {
                const shortLabel = truncateToWidth(pill.label, contentWidth - 12);
                const removeX = visibleWidth(shortLabel) + 2;
                rows.push({ text: shortLabel + '  [ Remove ]', bold: true, remove: pill.label, removeX });
              } else {
                rows.push(...wrapTextWithAnsi(pill.label, contentWidth).map(text => ({ text, bold: true })));
                rows.push({ text: '[ Remove ]', remove: pill.label, removeX: 0 });
              }
              if (pill.title) rows.push(...wrapTextWithAnsi(pill.title, contentWidth).map(text => ({ text })));
              if (pill.description) rows.push(...wrapTextWithAnsi(pill.description, contentWidth).map(text => ({ text })));
              const ticket = ticketOf(pill);
              if (ticket) {
                const status = statuses.get(ticket);
                const prLines = !status ? ['Checking PRs…'] : status.error ? [`PR check failed: ${status.error}`]
                  : status.prs.length ? status.prs.flatMap(pr => [`${describePr(pr)} · ${pr.url}`,
                    ...(pr.state === 'OPEN' ? pr.failedChecks ?? [] : []).map(check => `  ✗ ${check.name}${check.url ? ' · ' + check.url : ''}`)])
                  : ['No PR matched.'];
                for (const line of prLines) rows.push(...wrapTextWithAnsi(line, contentWidth).map(text => ({ text })));
              }
              rows.push({ text: '' });
            }
            if (!pills.length) rows.push({ text: 'No pills remaining.' });
            const available = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 8);
            maxScroll = Math.max(0, rows.length - available);
            if (initialTarget !== undefined) {
              scroll = starts.get(initialTarget) ?? 0;
              initialTarget = undefined;
            }
            if (revealFocus && focused !== undefined) {
              const index = rows.findIndex(r => r.remove === focused);
              if (index < scroll) scroll = index;
              else if (index >= scroll + available) scroll = index - available + 1;
            }
            revealFocus = false;
            scroll = Math.max(0, Math.min(scroll, maxScroll));
            const visible = rows.slice(scroll, scroll + available);
            const display = [{ text: '' }, { text: 'Active', bold: true }, { text: '' }, ...visible,
              { text: '' }, { text: '[ Close ]' }, { text: '↑↓/wheel: scroll · Tab: choose · Enter: select · Esc: close' }];
            regions = visible.flatMap((row, index) => row.remove === undefined ? [] : [{ label: row.remove,
              x: margin + (row.removeX ?? 0), y: index + 3,
              width: Math.min(10, contentWidth - (row.removeX ?? 0)) }]);
            regions.push({ x: margin, y: display.length - 2, width: Math.min(contentWidth, 9) });
            const bg = theme.colors.toolPendingBg, fg = theme.colors.text;
            const selectedBg = theme.colors.userMessageBg, selectedFg = theme.colors.text;
            return display.map((row, y) => {
              const text = ' '.repeat(margin) + truncateToWidth(row.text, contentWidth);
              const padded = text + ' '.repeat(Math.max(0, w - visibleWidth(text)));
              const selected = regions.find(r => r.y === y && r.label === focused);
              if (selected) return theme.style(sliceByColumn(padded, 0, selected.x), { fg, bg, bold: row.bold })
                + theme.style(sliceByColumn(padded, selected.x, selected.width), { fg: selectedFg, bg: selectedBg, bold: true })
                + theme.style(sliceByColumn(padded, selected.x + selected.width, w - selected.x - selected.width), { fg, bg });
              return theme.style(padded, { fg, bg, bold: row.bold });
            });
          },
          handleInput(data) {
            if (matchesKey(data, Key.escape)) done();
            else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) moveFocus();
            else if (matchesKey(data, Key.up)) { scroll = Math.max(0, scroll - 1); tui.requestRender(); }
            else if (matchesKey(data, Key.down)) { scroll = Math.min(maxScroll, scroll + 1); tui.requestRender(); }
            else if (matchesKey(data, Key.enter)) { if (focused === undefined) done(); else remove(focused); }
          },
          handleMouse(event) {
            if (event.type === 'wheel') {
              scroll = Math.max(0, Math.min(maxScroll, scroll + (event.wheelDelta ?? 0)));
              tui.requestRender(); return { handled: true };
            }
            if (event.type !== 'click' || event.button !== 'left') return;
            const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
            if (!hit) return;
            if (hit.label === undefined) done(); else remove(hit.label);
            return { handled: true };
          },
        }, theme);
      }, { overlay: true, overlayOptions: { width: '70%', maxHeight: '80%', anchor: 'center' } });
    } finally { panelOpen = false; }
  }

  pi.on('session_start', (_event, ctx) => {
    sessionContext = ctx; repo = undefined; statuses.clear();
    refresh(ctx);
    if (ctx.mode === 'tui') void addBranchTicket(ctx).finally(() => pollTickets(ctx));
  });
  pi.on('session_shutdown', () => { if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; sessionContext = undefined; });
  pi.events.on('pi-pills:current', (request: any) => {
    if (!sessionContext || request?.sessionId !== sessionContext.sessionManager.getSessionId()) return;
    try {
      request.labels = restore(sessionContext.sessionManager.getEntries()).map(pill => pill.label);
    } catch { request.error = 'Saved pill state could not be read.'; }
  });
  pi.on('before_agent_start', (_event, ctx) => {
    const content = reminderContext(restore(ctx.sessionManager.getEntries()), ticketPrefixes);
    if (hasRecentReminder(ctx.sessionManager.getBranch(), ctx.sessionManager.buildSessionProjection().entries, 'pipill-reminder', content)) return;
    return { message: { customType: 'pipill-reminder', content, display: false } };
  });
  pi.on('session_tree', (_event, ctx) => refresh(ctx));
  pi.registerTool({
    name: 'pipill',
    label: 'Pi pills',
    description: toolDescription(ticketPrefixes),
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('add'), Type.Literal('remove')]),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: 'Required for add/remove. Short topic label, or configured ticket-ID plus 2–3 meaningful words. Removal requires the exact case-sensitive label.' })),
      title: Type.Optional(Type.String({ maxLength: 500, description: 'For add only: optional fuller title.' })),
      description: Type.Optional(Type.String({ maxLength: 4000, description: 'For add only: optional context in one or two short sentences.' })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, _signal, _update, ctx) {
      const command = toolCommand(params);
      if (command.action === 'list') {
        refresh(ctx);
        if (stateError) throw new Error(stateError);
        const list = pills.map(p => ({ ...p }));
        return { content: [{ type: 'text', text: JSON.stringify({ pills: list }) }], details: { action: 'list', pills: list } };
      }
      const result = mutate(ctx, command, false);
      return {
        content: [{ type: 'text', text: result.message + (result.warning ? ' ' + result.warning : '') }],
        details: { action: command.action, changed: result.changed, pills: result.pills, warning: result.warning },
      };
    },
  });
  pi.registerCommand('pipill', {
    description: 'Add a reminder: "label" ["title"] ["description"]. Remove: "label" remove. No arguments: inspect.',
    handler: async (args, ctx) => {
      try {
        const command = parseArgs(args);
        if (command.action === 'inspect') await inspect(ctx);
        else mutate(ctx, command);
      } catch (e) { ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); }
    },
  });
}

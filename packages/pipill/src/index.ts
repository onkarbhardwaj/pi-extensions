import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { reminderContext, toolDescription } from './guidance.ts';
import { hasRecentReminder } from './reminder.ts';
import { Key, Markdown, matchesKey, visibleWidth, truncateToWidth, sliceByColumn } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { frame } from './frame.ts';
import { STATE_TYPE, parseArgs, toolCommand, restore, change, layout, ticketIds } from './core.ts';
import { type TicketPr, type TicketStatus, currentBranch, currentRepo, fetchTicketPrs, icons, notableChanges, repoKey, summarize } from './tickets.ts';
import { pillMarkdown } from './panel-markdown.ts';

type Pill = { label: string; title?: string; description?: string };

export default async function (pi: ExtensionAPI) {
  const { ticketPrefixes, repos, ci } = await loadConfig(join(getAgentDir(), 'pipill.json'));
  let pills: Pill[] = [];
  let stateError: string | undefined;
  let panelOpen = false;
  let sessionContext: ExtensionContext | undefined;
  const statuses = new Map<string, TicketStatus>();
  let repo: string | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const ticketOf = (pill: Pill) => ticketIds(pill.label, ticketPrefixes)[0];
  const ordered = () => [...pills.filter(pill => !ticketOf(pill)), ...pills.filter(pill => ticketOf(pill))];
  const POLL_MS = 5 * 60_000;

  async function pollTickets(ctx: ExtensionContext) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    if (polling || sessionContext !== ctx) return;
    polling = true;
    try {
      const tickets = [...new Set(pills.map(ticketOf).filter(Boolean))] as string[];
      if (tickets.length) {
        if (!repos.length) { try { repo ??= await currentRepo(ctx.cwd); } catch { repo = undefined; } }
        const targets = repos.length ? repos : repo ? [repo] : [];
        for (const ticket of tickets) {
          let next: TicketStatus;
          const found: TicketPr[] = [], errors: string[] = [];
          await Promise.all(targets.map(target => fetchTicketPrs(ticket, ctx.cwd, target, ci[repoKey(target)]?.ignore)
            .then(prs => { found.push(...prs); }, error => { errors.push(`${repoKey(target)}: ${error instanceof Error ? error.message : String(error)}`); })));
          found.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number);
          if (!targets.length) next = { prs: [], error: 'No GitHub repository found for this directory.', checkedAt: Date.now() };
          else if (errors.length === targets.length) next = { prs: statuses.get(ticket)?.prs ?? [], error: errors.join('; '), checkedAt: Date.now() };
          else next = { ...summarize(found), error: errors.length ? errors.join('; ') : undefined };
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
    const pr = status?.prs.find(item => item.state === 'OPEN') ?? status?.prs[0];
    // Without a PR, diff review can still find a local branch named after the ticket.
    const request = { label: pr?.branch ?? ticket, sessionId: ctx.sessionManager.getSessionId(), accepted: false };
    pi.events.emit('pi-diff-review:open', request);
    if (!request.accepted) ctx.ui.notify(`Diff review is unavailable.${pr ? ` ${ticket}: ${pr.url}` : ''}`, 'info');
  }

  function showWidget(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget('pi-pills', (tui, theme) => {
      let regions: { action: string; label?: string; x: number; y: number; width: number }[] = [];
      return {
        invalidate() { regions = []; },
        render(width: number) {
          const result = layout(ordered(), width, visibleWidth, (s: string, w: number) => truncateToWidth(s, w),
            (pill: Pill) => { const ticket = ticketOf(pill); return ticket ? icons(statuses.get(ticket)) : undefined; });
          regions = result.regions;
          const fg = theme.colors.accent;
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
        const REFRESH = '\u0000refresh', DIFF = '\u0000diff:';
        // Rendered Markdown per pill, reused while its source text is unchanged.
        const rendered = new Map<string, Markdown>();
        const hasTickets = () => pills.some(pill => ticketOf(pill));
        let refreshing = false;
        const refreshStatus = () => {
          if (refreshing) return;
          refreshing = true; tui.requestRender();
          void pollTickets(ctx).finally(() => { refreshing = false; tui.requestRender(); });
        };
        let revealFocus = false;
        let regions: { label?: string; x: number; y: number; width: number }[] = [];
        const remove = (target: string) => {
          mutate(ctx, { action: 'remove', label: target });
          focused = undefined;
          tui.requestRender();
        };
        const activate = (target: string | undefined) => {
          if (target === undefined) done();
          else if (target === REFRESH) refreshStatus();
          else if (target.startsWith(DIFF)) { done(); openDiff(ctx, target.slice(DIFF.length)); }
          else remove(target);
        };
        const moveFocus = () => {
          const choices = [undefined, ...(hasTickets() ? [REFRESH] : []),
            ...ordered().flatMap(p => ticketOf(p) ? [p.label, DIFF + p.label] : [p.label])];
          focused = choices[(choices.indexOf(focused) + 1) % choices.length];
          revealFocus = true;
          tui.requestRender();
        };
        return frame({
          invalidate() { regions = []; rendered.clear(); },
          render(width) {
            const w = Math.max(1, width);
            const margin = w >= 8 ? 2 : 0;
            const contentWidth = Math.max(1, w - margin * 2);
            type Row = { text: string; bold?: boolean; muted?: boolean; styled?: boolean; buttons?: [string, string | undefined][] };
            const rows: Row[] = [];
            const buttons = (items: [string, string | undefined][]): Row => ({ text: items.map(([label]) => label).join(' · '), buttons: items });
            const starts = new Map<string, number>();
            const used = new Set<string>();
            let section: string | undefined;
            for (const pill of ordered()) {
              const heading = ticketOf(pill) ? 'Tickets' : 'Topics';
              if (heading !== section) { rows.push({ text: heading, bold: true }); section = heading; }
              starts.set(pill.label, rows.length);
              const ticket = ticketOf(pill), status = ticket ? statuses.get(ticket) : undefined;
              const showRepo = new Set(status?.prs.map(pr => pr.repo)).size > 1 || repos.length > 1;
              const source = pillMarkdown(pill, ticket, status, showRepo);
              let view = rendered.get(source);
              if (!view) { view = new Markdown(source, 0, 0, getMarkdownTheme()); rendered.set(source, view); }
              used.add(source);
              rows.push(...view.render(contentWidth).map(text => ({ text, styled: true })));
              rows.push(buttons(ticket ? [['Remove', pill.label], ['Diff', DIFF + pill.label]] : [['Remove', pill.label]]), { text: '' });
            }
            for (const key of rendered.keys()) if (!used.has(key)) rendered.delete(key);
            if (!pills.length) rows.push({ text: 'No pills remaining.', muted: true }, { text: '' });
            const available = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 6);
            maxScroll = Math.max(0, rows.length - available);
            if (initialTarget !== undefined) {
              scroll = starts.get(initialTarget) ?? 0;
              initialTarget = undefined;
            }
            if (revealFocus && focused !== undefined) {
              const index = rows.findIndex(r => r.buttons?.some(([, target]) => target === focused));
              if (index >= 0 && index < scroll) scroll = index;
              else if (index >= scroll + available) scroll = index - available + 1;
            }
            revealFocus = false;
            scroll = Math.max(0, Math.min(scroll, maxScroll));
            const visible = rows.slice(scroll, scroll + available);
            const footer: [string, string | undefined][] = [['Close', undefined]];
            if (hasTickets()) footer.push([refreshing ? 'Refreshing…' : 'Refresh', refreshing ? '\u0000busy' : REFRESH]);
            const display: Row[] = [{ text: '' }, ...visible, buttons(footer),
              { text: 'Tab: choose · Enter: select · ↑↓/wheel: scroll · Esc: close', muted: true }];
            regions = [];
            display.forEach((row, y) => {
              let x = margin;
              for (const [label, target] of row.buttons ?? []) {
                if (target !== '\u0000busy') regions.push({ label: target, x, y, width: Math.min(visibleWidth(label), Math.max(0, margin + contentWidth - x)) });
                x += visibleWidth(label) + 3;
              }
            });
            const bg = theme.colors.toolPendingBg, fg = theme.colors.text, selectedBg = theme.colors.userMessageBg;
            return display.map((row, y) => {
              const text = ' '.repeat(margin) + truncateToWidth(row.text, contentWidth);
              const padded = text + ' '.repeat(Math.max(0, w - visibleWidth(text)));
              if (row.styled) return theme.style(padded, { bg });
              if (!row.buttons) return theme.style(padded, { fg: row.muted ? 'muted' : fg, bg, bold: row.bold });
              let out = '', at = 0;
              for (const region of regions.filter(r => r.y === y && r.width > 0)) {
                out += theme.style(sliceByColumn(padded, at, region.x - at), { fg: 'muted', bg });
                out += theme.style(sliceByColumn(padded, region.x, region.width), region.label === focused
                  ? { fg, bg: selectedBg, bold: true } : { fg: 'muted', bg });
                at = region.x + region.width;
              }
              return out + theme.style(sliceByColumn(padded, at, Math.max(0, w - at)), { fg: 'muted', bg });
            });
          },
          handleInput(data) {
            if (matchesKey(data, Key.escape)) done();
            else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) moveFocus();
            else if (matchesKey(data, Key.up)) { scroll = Math.max(0, scroll - 1); tui.requestRender(); }
            else if (matchesKey(data, Key.down)) { scroll = Math.min(maxScroll, scroll + 1); tui.requestRender(); }
            else if (matchesKey(data, Key.enter)) activate(focused);
          },
          handleMouse(event) {
            if (event.type === 'wheel') {
              scroll = Math.max(0, Math.min(maxScroll, scroll + (event.wheelDelta ?? 0)));
              tui.requestRender(); return { handled: true };
            }
            if (event.type !== 'click' || event.button !== 'left') return;
            const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
            if (!hit) return;
            activate(hit.label);
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

import { getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { reminderContext, toolDescription } from './guidance.ts';
import { hasRecentReminder } from './reminder.ts';
import { Key, Markdown, matchesKey, visibleWidth, truncateToWidth, sliceByColumn, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { frame } from './frame.ts';
import { STATE_TYPE, parseArgs, toolCommand, restore, change, layout, ticketIds } from './core.ts';
import { type TicketPr, type TicketStatus, currentBranch, currentRepo, fetchTicketPrs, icons, notableChanges, repoKey, summarize } from './tickets.ts';
import { pillBodyMarkdown, pillHeading, prListMarkdown } from './panel-markdown.ts';
import { type TimelineState, RECENT_SHOWN, TIMELINE_STATE_TYPE, adoptTopic, applyUpdates, backoffMs, buildInput, dismissTopic, newMessages, parseOutput, restoreTimeline, runSummarizer, suggestions } from './timeline.ts';
import type { ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

type Pill = { label: string; title?: string; description?: string };

export default async function (pi: ExtensionAPI) {
  const { ticketPrefixes, repos, ci, timeline } = await loadConfig(join(getAgentDir(), 'pipill.json'));
  let pills: Pill[] = [];
  let stateError: string | undefined;
  let panelOpen = false;
  let sessionContext: ExtensionContext | undefined;
  // Pi passes a fresh context object to every event, so compare sessions, not objects.
  const isCurrent = (ctx: ExtensionContext) => {
    try { return !!sessionContext && sessionContext.sessionManager.getSessionId() === ctx.sessionManager.getSessionId(); }
    catch { return false; }
  };
  let timelineState: TimelineState = { timelines: {}, recent: [], dismissed: [] };
  let timelineError: string | undefined;
  let timelineRedraw: (() => void) | undefined;
  let timelineRunning = false, timelineFailures = 0, timelineRetryAt = 0;
  let timelineChild: ChildProcess | undefined;

  const saveTimeline = (state: TimelineState) => {
    timelineState = state;
    pi.appendEntry(TIMELINE_STATE_TYPE, { version: 1, ...state });
  };

  function deleteTimeline(label: string) {
    const timelines = { ...timelineState.timelines };
    delete timelines[label];
    saveTimeline({ ...timelineState, timelines });
  }

  const ticketOfLabel = (label: string) => ticketIds(label, ticketPrefixes)[0];

  /** Adds a suggested topic as a pill and starts its timeline from the recent entries tagged with it. */
  function adoptSuggestion(ctx: ExtensionContext, label: string) {
    const result = mutate(ctx, { action: 'add', pill: { label } }, false);
    if (result.changed) saveTimeline(adoptTopic(restoreTimeline(ctx.sessionManager.getEntries()), label, ticketOfLabel));
    else ctx.ui.notify(result.message, 'info');
  }

  function dismissSuggestion(ctx: ExtensionContext, label: string) {
    saveTimeline(dismissTopic(restoreTimeline(ctx.sessionManager.getEntries()), label));
  }

  /**
   * Summarizes new messages into per-pill updates with a separate session-less Pi process, after a
   * turn settles. It never blocks the user, and no failure escapes: errors are shown in the panel,
   * the cursor stays put so the next run covers the same messages, and retries back off.
   */
  async function updateTimeline(ctx: ExtensionContext) {
    // Runs without pills too, since Recent covers work that no pill tracks yet.
    if (!timeline.enabled || timelineRunning || Date.now() < timelineRetryAt || !isCurrent(ctx)) return;
    timelineRunning = true;
    try {
      const current = restoreTimeline(ctx.sessionManager.getEntries());
      const batch = newMessages(ctx.sessionManager.getBranch(), current.cursor);
      if (batch.count < timeline.minMessages) return;
      const labels = pills.map(pill => pill.label);
      const output = await runSummarizer(buildInput(pills, current, batch.messages), timeline, child => { timelineChild = child; });
      if (!isCurrent(ctx)) return;
      const { updates, recent } = parseOutput(output, labels);
      saveTimeline(applyUpdates(restoreTimeline(ctx.sessionManager.getEntries()), updates, recent, batch.lastId));
      timelineFailures = 0; timelineRetryAt = 0; timelineError = undefined;
    } catch (error) {
      timelineFailures++;
      timelineRetryAt = Date.now() + backoffMs(timelineFailures);
      timelineError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    } finally {
      timelineRunning = false;
      try { timelineRedraw?.(); } catch {}
    }
  }
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
    if (polling || !isCurrent(ctx)) return;
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
          if (!isCurrent(ctx)) return;
          for (const message of notableChanges(ticket, statuses.get(ticket), next)) ctx.ui.notify(message, 'warning');
          statuses.set(ticket, next);
        }
        showWidget(ctx);
      }
    } finally {
      polling = false;
      if (isCurrent(ctx)) pollTimer = setTimeout(() => void pollTickets(ctx), POLL_MS);
    }
  }

  async function addBranchTicket(ctx: ExtensionContext) {
    const branch = await currentBranch(ctx.cwd);
    const ticket = branch && ticketIds(branch, ticketPrefixes)[0];
    if (!ticket || !isCurrent(ctx) || stateError) return;
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
    try { timelineState = restoreTimeline(ctx.sessionManager.getEntries()); } catch { timelineState = { timelines: {}, recent: [], dismissed: [] }; }
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
        const REFRESH = '\u0000refresh', DIFF = '\u0000diff:', TOGGLE = '\u0000toggle:', DELETE = '\u0000delete:';
        const ADD = '\u0000add:', DISMISS = '\u0000dismiss:', RECENT = '\u0000recent';
        const suggested = () => suggestions(timelineState, pills.map(pill => pill.label), ticketOfLabel);
        // Rendered Markdown per source text, reused while unchanged.
        const rendered = new Map<string, Markdown>();
        // Timelines always open collapsed; expansion lives only as long as the panel.
        const expanded = new Set<string>();
        let confirmDelete: string | undefined;
        const hasTickets = () => pills.some(pill => ticketOf(pill));
        const history = (label: string) => timelineState.timelines[label] ?? [];
        let refreshing = false;
        const refreshStatus = () => {
          if (refreshing) return;
          refreshing = true; tui.requestRender();
          void pollTickets(ctx).finally(() => { refreshing = false; tui.requestRender(); });
        };
        timelineRedraw = () => tui.requestRender();
        let revealFocus = false;
        let regions: { label?: string; x: number; y: number; width: number }[] = [];
        const remove = (target: string) => {
          mutate(ctx, { action: 'remove', label: target });
          focused = undefined;
          tui.requestRender();
        };
        const activate = (target: string | undefined) => {
          if (target !== undefined && target !== confirmDelete) confirmDelete = undefined;
          if (target === undefined) done();
          else if (target === REFRESH) refreshStatus();
          else if (target.startsWith(DIFF)) { done(); openDiff(ctx, target.slice(DIFF.length)); }
          else if (target.startsWith(TOGGLE)) {
            const name = target.slice(TOGGLE.length);
            if (!expanded.delete(name)) expanded.add(name);
            tui.requestRender();
          } else if (target.startsWith(DELETE)) {
            // Deleting cannot be undone, so it takes a second press.
            if (confirmDelete !== target) { confirmDelete = target; tui.requestRender(); return; }
            confirmDelete = undefined;
            deleteTimeline(target.slice(DELETE.length));
            expanded.delete(target.slice(DELETE.length));
            focused = undefined; tui.requestRender();
          } else if (target.startsWith(ADD)) {
            adoptSuggestion(ctx, target.slice(ADD.length));
            focused = undefined; tui.requestRender();
          } else if (target.startsWith(DISMISS)) {
            dismissSuggestion(ctx, target.slice(DISMISS.length));
            focused = undefined; tui.requestRender();
          } else remove(target);
        };
        const moveFocus = () => {
          const choices = [undefined, ...(hasTickets() ? [REFRESH] : []),
            ...(timelineState.recent.length ? [TOGGLE + RECENT] : []), ...suggested().flatMap(label => [ADD + label, DISMISS + label]),
            ...ordered().flatMap(p => [
            ...(history(p.label).length ? [TOGGLE + p.label] : []), p.label,
            ...(ticketOf(p) ? [DIFF + p.label] : []),
            ...(expanded.has(p.label) && history(p.label).length ? [DELETE + p.label] : [])])];
          focused = choices[(choices.indexOf(focused) + 1) % choices.length];
          revealFocus = true;
          tui.requestRender();
        };
        return frame({
          invalidate() { regions = []; rendered.clear(); },
          dispose() { timelineRedraw = undefined; },
          render(width) {
            const w = Math.max(1, width);
            const margin = w >= 8 ? 2 : 0;
            const contentWidth = Math.max(1, w - margin * 2);
            // A row is styled parts; parts with a target are clickable and focusable.
            type Part = { text: string; style?: any; target?: string | null };
            type Row = { parts: Part[]; styled?: boolean };
            const muted = { fg: 'muted' }, accent = { fg: 'accent' };
            const rows: Row[] = [];
            const text = (value: string, style: any = {}): Row => ({ parts: [{ text: value, style }] });
            const buttons = (items: [string, string | null][]): Row => ({
              parts: items.flatMap(([label, target], i) => [...(i ? [{ text: ' · ', style: muted }] : []), { text: label, style: muted, target }]) });
            const markdown = (source: string) => {
              if (!source) return;
              let view = rendered.get(source);
              if (!view) { view = new Markdown(source, 0, 0, getMarkdownTheme()); rendered.set(source, view); }
              used.add(source);
              // A pill reads as one unit, so drop the blank lines Markdown puts around its blocks.
              rows.push(...view.render(contentWidth).filter(line => stripVTControlCharacters(line).trim())
                .map(line => ({ parts: [{ text: line }], styled: true })));
            };
            const starts = new Map<string, number>();
            const used = new Set<string>();
            let section: string | undefined;
            // Recent work across all subjects: one line collapsed, the last few entries expanded,
            // then suggested topics that no pill covers yet.
            const recent = timelineState.recent.slice(-RECENT_SHOWN).reverse(), offers = suggested();
            if (recent.length || offers.length) {
              rows.push(text('RECENT', muted), text(''));
              const open = expanded.has(RECENT), toggle = { text: open ? '-' : '+', style: accent, target: TOGGLE + RECENT };
              if (recent.length && !open) rows.push({ parts: [toggle, { text: ' ' }, { text: recent[0].text }] });
              else recent.forEach((entry, i) => {
                const last = i === recent.length - 1, dot = last && recent.length > 1 ? '○' : '●';
                wrapTextWithAnsi(entry.text, Math.max(1, contentWidth - 5)).forEach((line, j) => rows.push({ parts: [
                  ...(i === 0 && j === 0 ? [toggle] : [{ text: ' ' }]),
                  { text: j === 0 ? ` ${dot}  ` : ` ${!last ? '│' : ' '}  `, style: muted }, { text: line }] }));
              });
              for (const label of offers) rows.push({ parts: [{ text: label, style: accent }, { text: '  ' },
                { text: '+', style: accent, target: ADD + label }, { text: ' ' }, { text: '×', style: muted, target: DISMISS + label }] });
              section = 'Recent';
            }
            for (const pill of ordered()) {
              const ticket = ticketOf(pill), status = ticket ? statuses.get(ticket) : undefined;
              const heading = ticket ? 'Tickets' : 'Topics';
              if (heading !== section) {
                // Gaps grow with the hierarchy: none inside a pill, one between pills, two between sections.
                if (section) rows.push(text(''));
                rows.push(text(heading.toUpperCase(), muted), text(''));
                section = heading;
              }
              starts.set(pill.label, rows.length);
              const updates = history(pill.label), open = expanded.has(pill.label);
              rows.push({ parts: [
                ...(updates.length ? [{ text: open ? '-' : '+', style: accent, target: TOGGLE + pill.label }, { text: ' ' }] : []),
                { text: pillHeading(pill.label, ticket, status), style: { fg: 'mdHeading', bold: true } }] });
              markdown(pillBodyMarkdown(pill));
              // Hidden until expanded; then newest first, dots joined by a line, the oldest hollow.
              const shown = open ? [...updates].reverse() : [];
              shown.forEach((update, i) => {
                const last = i === shown.length - 1, dot = last && shown.length > 1 ? '○' : '●';
                wrapTextWithAnsi(update, Math.max(1, contentWidth - 5)).forEach((line, j) => rows.push({ parts: [
                  { text: j === 0 ? `  ${dot}  ` : `  ${!last ? '│' : ' '}  `, style: muted }, { text: line }] }));
              });
              if (ticket) markdown(prListMarkdown(status, new Set(status?.prs.map(pr => pr.repo)).size > 1 || repos.length > 1));
              rows.push(buttons([
                [ticket ? 'Remove ticket' : 'Remove topic', pill.label],
                ...(ticket ? [['Diff', DIFF + pill.label] as [string, string]] : []),
                ...(open && updates.length ? [[confirmDelete === DELETE + pill.label ? 'Press again to delete timeline' : 'Delete timeline', DELETE + pill.label] as [string, string]] : []),
              ]), text(''));
            }
            for (const key of rendered.keys()) if (!used.has(key)) rendered.delete(key);
            if (!pills.length) rows.push(text('No pills remaining.', muted), text(''));
            const extra = timelineError ? 1 : 0;
            const available = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 6 - extra);
            maxScroll = Math.max(0, rows.length - available);
            if (initialTarget !== undefined) {
              scroll = starts.get(initialTarget) ?? 0;
              initialTarget = undefined;
            }
            if (revealFocus && focused !== undefined) {
              const index = rows.findIndex(r => r.parts.some(part => part.target === focused));
              if (index >= 0 && index < scroll) scroll = index;
              else if (index >= scroll + available) scroll = index - available + 1;
            }
            revealFocus = false;
            scroll = Math.max(0, Math.min(scroll, maxScroll));
            const footer: [string, string | null][] = [['Close', null]];
            if (hasTickets()) footer.push([refreshing ? 'Refreshing…' : 'Refresh', refreshing ? '\u0000busy' : REFRESH]);
            const display: Row[] = [text(''), ...rows.slice(scroll, scroll + available), buttons(footer),
              ...(timelineError ? [text(`⚠ Timeline update failed: ${timelineError}`, { fg: 'warning' })] : []),
              text('Tab: choose · Enter: select · ↑↓/wheel: scroll · Esc: close', muted)];
            const bg = theme.colors.toolPendingBg, fg = theme.colors.text, selectedBg = theme.colors.userMessageBg;
            regions = [];
            return display.map((row, y) => {
              let out = theme.style(' '.repeat(margin), { bg }), x = margin;
              for (const part of row.parts) {
                const room = margin + contentWidth - x;
                if (room <= 0) break;
                const clipped = truncateToWidth(part.text, room), size = visibleWidth(clipped);
                const clickable = part.target !== undefined && part.target !== '\u0000busy';
                const target = part.target === null ? undefined : part.target;
                if (clickable) regions.push({ label: target, x, y, width: size });
                const active = clickable && target === focused;
                out += row.styled ? theme.style(clipped, { bg })
                  : theme.style(clipped, { fg, bg, ...part.style, ...(active ? { fg, bg: selectedBg, bold: true } : {}) });
                x += size;
              }
              return out + theme.style(' '.repeat(Math.max(0, w - x)), { bg });
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
  pi.on('agent_settled', (_event, ctx) => { void updateTimeline(ctx).catch(() => {}); });
  pi.on('session_shutdown', () => {
    if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; sessionContext = undefined;
    try { timelineChild?.kill('SIGKILL'); } catch {}
    timelineChild = undefined;
  });
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

import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi, sliceByColumn, rgbColor } from '@earendil-works/pi-tui';
import { join } from 'node:path';
import { frame } from './frame.ts';
import { parseArgs, loadConfig, resolveTarget, snapshot, selectedExcerpt, preparedReview, safeText, diffMatches } from './core.ts';

export default function (pi: ExtensionAPI) {
  let open = false;
  let sessionContext;
  const runReview = async (args, ctx, patternOverride?: string) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('Diff review requires interactive terminal mode.', 'warning'); return; }
      if (open) { ctx.ui.notify('A diff review is already open.', 'info'); return; }
      open = true;
      try {
        const command = patternOverride === undefined ? parseArgs(args) : { pattern: patternOverride };
        const config = await loadConfig(join(getAgentDir(), 'diff-review', 'config.json'));
        ctx.ui.notify('Capturing diff…', 'info');
        const target = await resolveTarget(config, command.pattern);
        const review = await snapshot(target, command.base);
        if (!review.files.length) { ctx.ui.notify('No changes against the merge base.', 'info'); return; }
        let renderer;
        const notes: any[] = [];
        const result = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
          renderer = tui;
          let fileIndex = 0, cursor = 0, anchor = 0, scroll = 0, maxScroll = 0;
          let follow = true, focused = 'add', status = '', showHelp = false;
          let entering = false, editing: number | undefined, pendingSelection;
          let regions: any[] = [], helpScroll = 0, helpMax = 0;
          let preferredListWidth: number | undefined;
          let listMin = 16, listMax = 30, currentListWidth = 0;
          let dividerX = -1, dividerTop = 0, dividerBottom = 0, draggingDivider = false;
          let componentFocused = false;
          const input = new Input({ prompt: 'Comment: ' });
          const search = new Input({ prompt: '' });
          let searching = false, query = '', searchKey = '', matchIndex = 0, seekMatch = false;
          let matches: { row: number; start: number; end: number }[] = [];
          const matchRows = new Map<number, number[]>();
          const beginSearch = () => { searching = true; search.focused = componentFocused; tui.requestRender(); };
          const finishSearch = () => {
            searching = false; search.focused = false; search.setValue(''); query = ''; matches = []; matchRows.clear();
            matchIndex = 0; searchKey = ''; seekMatch = false; follow = false; focused = 'add'; tui.requestRender();
          };
          search.onSubmit = finishSearch; search.onEscape = finishSearch;
          const nextMatch = (delta: number) => {
            if (matches.length) { matchIndex = (matchIndex + delta + matches.length) % matches.length; seekMatch = true; follow = false; }
            tui.requestRender();
          };
          const chooseFile = (index: number) => {
            fileIndex = Math.max(0, Math.min(review.files.length - 1, index));
            const rows = review.files[fileIndex].rows;
            cursor = Math.max(0, rows.findIndex(r => r.newLine !== undefined || r.oldLine !== undefined));
            anchor = cursor;
            scroll = 0; follow = true; focused = 'add'; status = ''; searchKey = ''; matchIndex = 0; seekMatch = !!query; tui.requestRender();
          };
          chooseFile(0);
          const beginComment = (index?: number) => {
            try {
              pendingSelection = index === undefined ? selectedExcerpt(review.files[fileIndex], anchor, cursor) : notes[index].selection;
              editing = index; entering = true; input.focused = componentFocused;
              input.setValue(index === undefined ? '' : notes[index].comment);
              status = 'Enter saves; Escape discards this input.'; tui.requestRender();
            } catch (e) { status = String(e); tui.requestRender(); }
          };
          input.onSubmit = value => {
            if (!value.trim()) { status = 'Comment cannot be empty.'; tui.requestRender(); return; }
            if (editing === undefined) notes.push({ fileIndex, selection: pendingSelection, comment: value });
            else notes[editing] = { ...notes[editing], comment: value };
            entering = false; input.focused = false; editing = undefined; status = 'Comment saved.'; tui.requestRender();
          };
          input.onEscape = () => { entering = false; input.focused = false; status = ''; tui.requestRender(); };
          const actions = () => ['search', 'add', ...notes.flatMap((note, i) => note.fileIndex === fileIndex ? [`edit:${i}`, `delete:${i}`] : []), 'ready', 'cancel', 'help'];
          const activate = (action: string) => {
            if (action === 'help') { showHelp = !showHelp; tui.requestRender(); }
            else if (action === 'search') beginSearch();
            else if (action === 'add') beginComment();
            else if (action.startsWith('edit:')) beginComment(Number(action.split(':')[1]));
            else if (action.startsWith('delete:')) { notes.splice(Number(action.split(':')[1]), 1); focused = 'add'; tui.requestRender(); }
            else if (action === 'cancel') done(undefined);
            else if (action === 'ready') {
              try { done(preparedReview(review, notes)); } catch (e) { status = String(e); tui.requestRender(); }
            }
          };
          return frame({
            get focused() { return componentFocused; },
            set focused(value) { componentFocused = value; input.focused = value && entering; search.focused = value && searching; },
            invalidate() { regions = []; input.invalidate(); search.invalidate(); },
            render(width) {
              const margin = width >= 8 ? 1 : 0;
              const total = Math.max(1, width - margin * 2);
              listMax = Math.max(listMin, total - 34);
              const listWidth = width >= 70 ? Math.max(listMin, Math.min(listMax, preferredListWidth ?? Math.min(30, Math.floor(total * 0.28)))) : 0;
              currentListWidth = listWidth;
              const rightX = margin + (listWidth ? listWidth + 2 : 0);
              const w = Math.max(1, width - rightX - margin);
              const current = review.files[fileIndex];
              const key = JSON.stringify([fileIndex, query]);
              if (key !== searchKey) { matches = diffMatches(current.rows, query); matchIndex = Math.min(matchIndex, Math.max(0, matches.length - 1)); searchKey = key;
                matchRows.clear(); matches.forEach((hit, i) => { const items = matchRows.get(hit.row) ?? []; items.push(i); matchRows.set(hit.row, items); });
              }
              const rows: any[] = [];
              current.rows.forEach((row, sourceIndex) => {
                const prefix = `${String(row.oldLine ?? '').padStart(5)} ${String(row.newLine ?? '').padStart(5)} ${row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ' '} `;
                const raw = safeText(row.text), prefixWidth = visibleWidth(prefix);
                const chunks = wrapTextWithAnsi(raw || ' ', Math.max(1, w - prefixWidth));
                let from = 0;
                chunks.forEach((text, part) => {
                  const textOffset = Math.max(from, raw.indexOf(text, from)); from = textOffset + text.length;
                  rows.push({ text: (part ? ' '.repeat(prefixWidth) : prefix) + text, sourceIndex, kind: row.kind, textOffset, chunk: text, prefixWidth });
                });
              });
              rows.push({ text: '' }, { text: 'Comments on this file', bold: true });
              notes.forEach((note, i) => {
                if (note.fileIndex !== fileIndex) return;
                rows.push({ text: 'Selected diff excerpt', bold: true });
                rows.push(...wrapTextWithAnsi(safeText(note.selection.excerpt), w).map(text => ({ text })));
                rows.push(...wrapTextWithAnsi(safeText(note.comment), w).map(text => ({ text })));
                rows.push({ text: '[ Edit ]  [ Delete ]', actions: [{ x: 0, width: 8, action: `edit:${i}` }, { x: 10, width: 10, action: `delete:${i}` }] });
                rows.push({ text: '' });
              });
              let helpLines = entering ? ['Enter saves · Esc back'] : showHelp ? [
                '[?] Help · ↑↓ scroll · Esc back',
                'Tab: focus controls · Enter: comment/activate · Esc: close viewer',
                '↑↓: line · Shift+↑↓ or Shift+click: select excerpt · ←→: switch file',
                'Wheel: scroll · Drag divider or [ ]: resize file list',
                '/ or click Search: search diff · ↑↓: matches · ←→: edit query · Enter/Esc: end search',
                'Ready: append review JSON to draft, never send',
              ].flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - margin * 2))) : [width >= 65
                ? 'Shift+↑↓ select · Enter comment · Esc close · [?] Help'
                : '[?] Help · Esc close'];
              if (showHelp && !entering) {
                const limit = Math.max(1, Math.min(8, Math.floor(tui.terminal.rows * .9) - 11));
                helpMax = Math.max(0, helpLines.length - limit); helpScroll = Math.min(helpScroll, helpMax);
                helpLines = helpLines.slice(helpScroll, helpScroll + limit);
              }
              const viewport = Math.max(1, Math.floor(tui.terminal.rows * 0.9) - 9 - helpLines.length);
              maxScroll = Math.max(0, rows.length - viewport);
              if (follow) {
                const index = focused.startsWith('edit:') || focused.startsWith('delete:')
                  ? rows.findIndex(r => r.actions?.some(a => a.action === focused)) : rows.findIndex(r => r.sourceIndex === cursor);
                if (index >= 0 && index < scroll) scroll = index;
                else if (index >= scroll + viewport) scroll = index - viewport + 1;
                follow = false;
              }
              if (seekMatch) {
                const hit = matches[matchIndex];
                const index = hit ? rows.findIndex(r => r.sourceIndex === hit.row && hit.start < r.textOffset + r.chunk.length && hit.end > r.textOffset) : -1;
                if (index >= 0) scroll = Math.max(0, index - Math.floor(viewport / 2));
                seekMatch = false;
              }
              scroll = Math.max(0, Math.min(scroll, maxScroll));
              const visible = rows.slice(scroll, scroll + viewport);
              const path = current.path ?? current.oldPath;
              const fileCounts = review.files.map((_, index) => notes.filter(note => note.fileIndex === index).length);
              const counter = `Comments: ${notes.length}`;
              const searchWidth = Math.min(Math.max(12, Math.floor(total * .45)), Math.max(1, total - 1));
              const count = searching ? (query ? ` ↑ ${matches.length ? matchIndex + 1 : 0}/${matches.length} ↓  ↵ Done` : ' ↵ Done') : '';
              const countWidth = Math.min(visibleWidth(count), Math.max(0, searchWidth - 9));
              const fieldWidth = Math.max(1, searchWidth - countWidth);
              const field = searching ? search.render(Math.max(1, fieldWidth - 8)).join('') : '';
              const searchX = margin + total - searchWidth;
              const titleWidth = Math.max(1, total - searchWidth);
              const title = truncateToWidth(`Review · ${review.repository} · ${review.branch} · base ${review.base}`, titleWidth);
              const header = [
                title + ' '.repeat(Math.max(0, total - searchWidth - visibleWidth(title))),
                `${review.worktree} · ${counter}`,
                `${current.status} ${safeText(current.oldPath && current.path && current.oldPath !== current.path ? current.oldPath + ' → ' + current.path : path)} · file comments: ${fileCounts[fileIndex]}`,
                '',
              ];
              const dark = theme.appearance !== 'light';
              const fg = dark ? rgbColor(240, 235, 220) : rgbColor(45, 38, 25);
              const bg = dark ? rgbColor(45, 43, 38) : rgbColor(243, 239, 228);
              const addFg = dark ? rgbColor(150, 225, 165) : rgbColor(25, 100, 40);
              const deleteFg = dark ? rgbColor(255, 165, 165) : rgbColor(145, 35, 35);
              const selectedBg = dark ? rgbColor(100, 78, 42) : rgbColor(214, 190, 150);
              const activeBg = dark ? rgbColor(240, 210, 160) : rgbColor(80, 51, 18);
              const activeFg = dark ? rgbColor(40, 30, 15) : rgbColor(255, 240, 213);
              const paint = (text, w, options = {}) => {
                const t = truncateToWidth(text, w); return theme.style(t + ' '.repeat(Math.max(0, w - visibleWidth(t))), { fg, bg, ...options });
              };
              regions = [{ x: searchX, y: 0, width: searchWidth, action: 'search' }];
              const display = header.map((text, i) => paint(' '.repeat(margin) + text, width, { bold: i === 0 }));
              const searchStyle = searching ? { bg: selectedBg } : {};
              const searchField = searching
                ? paint('Search: ', Math.min(8, fieldWidth), { ...searchStyle, fg: theme.colors.accent, bold: true })
                  + paint(field, Math.max(0, fieldWidth - 8), searchStyle)
                : paint('Search: /', fieldWidth);
              display[0] = paint(' '.repeat(margin) + header[0], searchX, { bold: true })
                + searchField + paint(count, countWidth, searchStyle) + paint('', margin);
              const bodyHeight = Math.min(viewport, Math.max(visible.length, listWidth ? Math.min(review.files.length, viewport) : 0));
              const fileStart = Math.max(0, Math.min(fileIndex - Math.floor(bodyHeight / 2), review.files.length - bodyHeight));
              dividerX = listWidth ? margin + listWidth + 1 : -1;
              dividerTop = header.length;
              dividerBottom = header.length + bodyHeight;
              for (let i = 0; i < bodyHeight; i++) {
                let left = '';
                if (listWidth) {
                  const index = fileStart + i;
                  const file = review.files[index];
                  if (file) regions.push({ x: margin, y: header.length + i, width: listWidth, fileIndex: index });
                  left = paint(file ? `${index === fileIndex ? '›' : ' '} ${fileCounts[index] ? '●' + fileCounts[index] + ' ' : ''}${safeText(file.path ?? file.oldPath)}` : '', listWidth,
                    { bg: index === fileIndex ? selectedBg : bg, bold: index === fileIndex }) + paint(' │', 2);
                }
                const row = visible[i] ?? { text: '' };
                const y = header.length + i;
                if (row.sourceIndex !== undefined) regions.push({ x: rightX, y, width: w, sourceIndex: row.sourceIndex });
                for (const a of row.actions ?? []) if (a.x < w) regions.push({ x: rightX + a.x, y, width: Math.min(a.width, w - a.x), action: a.action });
                const active = !entering && regions.find(r => r.y === y && r.action === focused);
                const selected = row.sourceIndex !== undefined && row.sourceIndex >= Math.min(anchor, cursor) && row.sourceIndex <= Math.max(anchor, cursor);
                const color = row.kind === 'add' ? addFg : row.kind === 'delete' ? deleteFg : fg;
                let right = paint(row.text, w, { fg: color, bg: selected ? selectedBg : bg, bold: row.bold });
                if (row.sourceIndex !== undefined && query) {
                  for (const j of [...(matchRows.get(row.sourceIndex) ?? [])].reverse()) {
                    const hit = matches[j];
                    const start = Math.max(hit.start, row.textOffset) - row.textOffset;
                    const end = Math.min(hit.end, row.textOffset + row.chunk.length) - row.textOffset;
                    if (end <= start) continue;
                    const x = row.prefixWidth + visibleWidth(row.chunk.slice(0, start)), size = visibleWidth(row.chunk.slice(start, end));
                    right = sliceByColumn(right, 0, x) + theme.style(row.chunk.slice(start, end), { fg: color, bg: selectedBg, bold: true, underline: j === matchIndex })
                      + sliceByColumn(right, x + size, Math.max(0, w - x - size));
                  }
                }
                if (active) {
                  const x = active.x - rightX;
                  const t = truncateToWidth(row.text, w); const padded = t + ' '.repeat(Math.max(0, w - visibleWidth(t)));
                  right = paint(sliceByColumn(padded, 0, x), x) + paint(sliceByColumn(padded, x, active.width), active.width, { fg: activeFg, bg: activeBg, bold: true })
                    + paint(sliceByColumn(padded, x + active.width, w - x - active.width), w - x - active.width);
                }
                display.push(paint(' '.repeat(margin), margin) + left + right + paint(' '.repeat(margin), margin));
              }
              display.push(paint('', width));
              const footerY = display.length;
              const buttons = [{ text: '[ Add comment ]', action: 'add' }, { text: '[ Ready ]', action: 'ready' }, { text: '[ Cancel ]', action: 'cancel' }];
              let footer = paint(' '.repeat(margin), margin), x = margin;
              if (entering) footer += paint(input.render(total).join(''), total);
              else for (const button of buttons) {
                const size = Math.min(visibleWidth(button.text), Math.max(0, width - x));
                if (size) {
                  regions.push({ x, y: footerY, width: size, action: button.action });
                  footer += paint(button.text, size, focused === button.action ? { fg: activeFg, bg: activeBg, bold: true } : {});
                  x += size; const gap = Math.min(2, Math.max(0, width - x)); footer += paint('', gap); x += gap;
                }
              }
              display.push(truncateToWidth(footer, width));
              display.push(paint(' '.repeat(margin) + status, width));
              for (const line of helpLines) {
                const x = line.indexOf('[?] Help');
                if (!entering && x >= 0) regions.push({ x: margin + x, y: display.length, width: Math.min(8, Math.max(0, width - margin - x)), action: 'help' });
                display.push(paint(' '.repeat(margin) + line, width));
              }
              return display;
            },
            handleInput(data) {
              if (entering) { input.handleInput(data); tui.requestRender(); return; }
              if (searching) {
                if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) { nextMatch(matchesKey(data, Key.down) ? 1 : -1); return; }
                search.handleInput(data);
                if (query !== search.getValue()) { query = search.getValue(); matchIndex = 0; seekMatch = true; follow = false; }
                tui.requestRender(); return;
              }
              if (data === '?') { showHelp = !showHelp; tui.requestRender(); return; }
              if (showHelp && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
                helpScroll = Math.max(0, Math.min(helpMax, helpScroll + (matchesKey(data, Key.down) ? 1 : -1))); tui.requestRender(); return;
              }
              if (showHelp && matchesKey(data, Key.escape)) { showHelp = false; tui.requestRender(); return; }
              if (data === '/') { beginSearch(); return; }
              if (matchesKey(data, Key.escape)) done(undefined);
              else if (matchesKey(data, Key.left)) chooseFile(fileIndex - 1);
              else if (matchesKey(data, Key.right)) chooseFile(fileIndex + 1);
              else if ((data === '[' || data === ']') && currentListWidth) {
                preferredListWidth = Math.max(listMin, Math.min(listMax, currentListWidth + (data === ']' ? 4 : -4)));
                tui.requestRender();
              }
              else if (matchesKey(data, Key.tab)) { const choices = actions(); focused = choices[(choices.indexOf(focused) + 1) % choices.length]; follow = true; tui.requestRender(); }
              else if (matchesKey(data, Key.enter)) activate(focused);
              else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'))) {
                const up = matchesKey(data, Key.up) || matchesKey(data, Key.shift('up'));
                const extend = matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'));
                const rows = review.files[fileIndex].rows;
                cursor = Math.max(0, Math.min(rows.length - 1, cursor + (up ? -1 : 1)));
                if (!extend) anchor = cursor;
                focused = 'add'; follow = true; tui.requestRender();
              }
            },
            handleMouse(event) {
              if (entering) return { handled: true };
              if (searching && event.type === 'click' && event.y !== 0) finishSearch();
              if (draggingDivider && (event.type === 'drag' || event.type === 'release')) {
                preferredListWidth = Math.max(listMin, Math.min(listMax, event.x - 2));
                if (event.type === 'release') draggingDivider = false;
                tui.requestRender(); return { handled: true };
              }
              if (event.type === 'press' && event.button === 'left' && dividerX >= 0
                && event.x >= dividerX - 1 && event.x <= dividerX && event.y >= dividerTop && event.y < dividerBottom) {
                draggingDivider = true; return { handled: true, capture: true };
              }
              if (event.type === 'wheel') { scroll = Math.max(0, Math.min(maxScroll, scroll + (event.wheelDelta ?? 0))); tui.requestRender(); return { handled: true }; }
              if (event.type !== 'click' || event.button !== 'left') return;
              const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
              if (!hit) return;
              if (hit.fileIndex !== undefined) chooseFile(hit.fileIndex);
              else if (hit.action) { focused = hit.action; activate(hit.action); }
              else {
                cursor = hit.sourceIndex;
                if (!event.shift) anchor = cursor;
                focused = 'add'; tui.requestRender();
              }
              return { handled: true };
            },
          }, theme);
        }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '90%', anchor: 'center' } });
        if (result !== undefined) {
          const draft = ctx.ui.getEditorText();
          ctx.ui.setEditorText(draft ? draft + '\n\n' + result : result);
          renderer?.requestRender();
        }
      } catch (e) { ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); }
      finally { open = false; }
  };
  pi.registerCommand('d', {
    description: 'Review branch plus working changes: /d <branch-substring> [--base <ref>]. Ready prepares JSON, never submits.',
    handler: runReview,
  });
  pi.on('session_start', (_event, ctx) => { sessionContext = ctx; });
  pi.on('session_shutdown', () => { sessionContext = undefined; });
  pi.events.on('pi-diff-review:available', (request: any) => {
    if (sessionContext?.mode === 'tui'
      && request?.sessionId === sessionContext.sessionManager.getSessionId()) {
      request.available = true;
    }
  });
  pi.events.on('pi-diff-review:open', (data: any) => {
    if (!sessionContext || typeof data?.label !== 'string' || !data.label.trim()
      || data.sessionId !== sessionContext.sessionManager.getSessionId()) return;
    data.accepted = true;
    void runReview('', sessionContext, data.label).catch(error => sessionContext.ui.notify(String(error), 'error'));
  });
}

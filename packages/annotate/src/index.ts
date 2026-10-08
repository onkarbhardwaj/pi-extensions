import { TreeSelectorComponent, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, visibleWidth, truncateToWidth, wrapTextWithAnsi, rgbColor, sliceByColumn } from '@earendil-works/pi-tui';
import { sourceFromEntry, selectRange, sourceRows, feedback, appendDraft, safeText } from './core.mjs';
import { frame } from './frame.ts';

type Note = { start: number; end: number; comment: string };
export default function (pi: ExtensionAPI) {
  let open = false;
  const handler = async (_args, ctx) => {
    if (ctx.mode !== 'tui') { ctx.ui.notify('Annotation requires the interactive terminal UI.', 'warning'); return; }
    if (open) return;
    open = true;
    try {
      // Use Pi's real tree browser, but selection only returns an entry ID.
      const id = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
        return new TreeSelectorComponent(ctx.sessionManager.getTree(), ctx.sessionManager.getLeafId(),
          tui.terminal.rows, entryId => {
            if (!sourceFromEntry(ctx.sessionManager.getEntry(entryId))) {
              ctx.ui.notify('Choose a user/assistant text message without images.', 'warning');
              tui.requestRender(); return;
            }
            done(entryId);
          }, () => done(undefined), undefined, undefined, 'no-tools');
      });
      if (!id) return;
      const source = sourceFromEntry(ctx.sessionManager.getEntry(id));
      if (!source) return;
      const notes: Note[] = [];
      let renderer;
      const result = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
        renderer = tui;
        let cursor = 0, anchor = 0, scroll = 0, maxScroll = 0;
        let followSelection = true;
        let focused = 'add';
        let editing: number | undefined;
        let enteringComment = false;
        let status = '';
        let regions: { x: number; y: number; width: number; action?: string; sourceLine?: number }[] = [];
        const input = new Input({ prompt: 'Comment: ' });
        let componentFocused = false;
        const beginComment = (index?: number) => {
          editing = index;
          input.setValue(index === undefined ? '' : notes[index].comment);
          enteringComment = true; input.focused = componentFocused;
          status = 'Enter saves comment; Escape returns without saving.';
          tui.requestRender();
        };
        input.onSubmit = value => {
          if (!value.trim()) { status = 'Comment cannot be empty.'; tui.requestRender(); return; }
          if (editing === undefined) notes.push({ ...selectRange(anchor, cursor, source.lines.length), comment: value });
          else notes[editing] = { ...notes[editing], comment: value };
          enteringComment = false; input.focused = false; editing = undefined;
          status = 'Comment saved. Select another range or choose Ready.';
          tui.requestRender();
        };
        input.onEscape = () => { enteringComment = false; input.focused = false; status = ''; tui.requestRender(); };
        const actions = () => ['add', ...notes.flatMap((_, i) => [`edit:${i}`, `delete:${i}`]), 'ready', 'cancel'];
        const activate = (action: string) => {
          status = '';
          if (action === 'add') beginComment();
          else if (action.startsWith('edit:')) beginComment(Number(action.split(':')[1]));
          else if (action.startsWith('delete:')) { notes.splice(Number(action.split(':')[1]), 1); focused = 'add'; tui.requestRender(); }
          else if (action === 'cancel') done(undefined);
          else if (action === 'ready') {
            try { done(feedback(source, notes)); }
            catch (e) { status = String(e); tui.requestRender(); }
          }
        };
        return frame({
          get focused() { return componentFocused; },
          set focused(value: boolean) { componentFocused = value; input.focused = value && enteringComment; },
          invalidate() { regions = []; input.invalidate(); },
          render(width) {
            const margin = width >= 8 ? 2 : 0;
            const w = Math.max(1, width - 2 * margin);
            const rows: any[] = sourceRows(source, w, wrapTextWithAnsi);
            rows.push({ text: '' }, { text: `Comments (${notes.length})`, bold: true });
            notes.forEach((note, index) => {
              rows.push({ text: `${index + 1}. Lines ${note.start + 1}–${note.end + 1}`, bold: true });
              rows.push(...wrapTextWithAnsi(safeText(note.comment), w).map(text => ({ text })));
              rows.push({ text: '[ Edit ]  [ Delete ]', actions: [{ x: 0, width: 8, action: `edit:${index}` }, { x: 10, width: 10, action: `delete:${index}` }] });
              rows.push({ text: '' });
            });
            const viewport = Math.max(1, Math.floor(tui.terminal.rows * 0.85) - 9);
            maxScroll = Math.max(0, rows.length - viewport);
            if (followSelection) {
              const target = focused.startsWith('edit:') || focused.startsWith('delete:')
                ? rows.findIndex(r => r.actions?.some(a => a.action === focused))
                : rows.findIndex(r => r.sourceLine === cursor);
              if (target < scroll) scroll = target;
              else if (target >= scroll + viewport) scroll = target - viewport + 1;
              followSelection = false;
            }
            scroll = Math.max(0, Math.min(maxScroll, scroll));
            const visible = rows.slice(scroll, scroll + viewport);
            const display: any[] = [{ text: `Annotate · ${source.role} · ${source.id}`, bold: true },
              { text: `Selected lines ${Math.min(anchor, cursor) + 1}–${Math.max(anchor, cursor) + 1}` }, { text: '' }, ...visible];
            display.push({ text: '' });
            if (enteringComment) display.push({ text: input.render(w).join(''), raw: true });
            else display.push({ text: '[ Add comment ]  [ Ready ]  [ Cancel ]', actions: [
              { x: 0, width: 15, action: 'add' }, { x: 17, width: 9, action: 'ready' }, { x: 28, width: 10, action: 'cancel' }] });
            display.push({ text: status });
            display.push({ text: enteringComment ? 'Enter: save · Esc: back' : '↑↓: line · Shift+↑↓/click: range · Tab: control · Enter: choose · Esc: cancel' });
            regions = [];
            const dark = theme.appearance !== 'light';
            const bg = dark ? rgbColor(65, 52, 35) : rgbColor(244, 229, 202);
            const fg = dark ? rgbColor(255, 233, 195) : rgbColor(80, 51, 18);
            const selectedBg = dark ? rgbColor(105, 80, 45) : rgbColor(215, 193, 158);
            const activeBg = dark ? rgbColor(245, 220, 175) : rgbColor(80, 51, 18);
            const activeFg = dark ? rgbColor(50, 35, 18) : rgbColor(255, 240, 213);
            const range = selectRange(anchor, cursor, source.lines.length);
            return display.map((row, y) => {
              const text = truncateToWidth(row.text, w);
              const padded = ' '.repeat(margin) + text + ' '.repeat(Math.max(0, width - margin - visibleWidth(text)));
              if (row.sourceLine !== undefined) regions.push({ x: margin, y, width: w, sourceLine: row.sourceLine });
              for (const a of row.actions ?? []) {
                if (a.x < w) regions.push({ x: margin + a.x, y, width: Math.min(a.width, w - a.x), action: a.action });
              }
              const active = !enteringComment && regions.find(r => r.y === y && r.action === focused);
              if (active) return theme.style(sliceByColumn(padded, 0, active.x), { fg, bg })
                + theme.style(sliceByColumn(padded, active.x, active.width), { fg: activeFg, bg: activeBg, bold: true })
                + theme.style(sliceByColumn(padded, active.x + active.width, width - active.x - active.width), { fg, bg });
              return theme.style(padded, { fg, bg: row.sourceLine >= range.start && row.sourceLine <= range.end ? selectedBg : bg, bold: row.bold });
            });
          },
          handleInput(data) {
            if (enteringComment) { input.handleInput(data); tui.requestRender(); return; }
            if (matchesKey(data, Key.escape)) done(undefined);
            else if (matchesKey(data, Key.tab)) {
              const choices = actions(); focused = choices[(choices.indexOf(focused) + 1) % choices.length];
              followSelection = true; tui.requestRender();
            } else if (matchesKey(data, Key.enter)) activate(focused);
            else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'))) {
              const up = matchesKey(data, Key.up) || matchesKey(data, Key.shift('up'));
              const extend = matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'));
              cursor = Math.max(0, Math.min(source.lines.length - 1, cursor + (up ? -1 : 1)));
              if (!extend) anchor = cursor;
              focused = 'add'; followSelection = true; tui.requestRender();
            }
          },
          handleMouse(event) {
            if (enteringComment) return { handled: true };
            if (event.type === 'wheel') { scroll = Math.max(0, Math.min(maxScroll, scroll + (event.wheelDelta ?? 0))); tui.requestRender(); return { handled: true }; }
            if (event.type !== 'click' || event.button !== 'left') return;
            const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
            if (!hit) return;
            if (hit.action) { focused = hit.action; activate(hit.action); }
            else { cursor = hit.sourceLine!; if (!event.shift) anchor = cursor; focused = 'add'; tui.requestRender(); }
            return { handled: true };
          },
        }, theme);
      }, { overlay: true, overlayOptions: { width: '85%', maxHeight: '85%', anchor: 'center' } });
      if (result !== undefined) {
        ctx.ui.setEditorText(appendDraft(ctx.ui.getEditorText(), result));
        renderer?.requestRender();
      }
    } finally { open = false; }
  };
  for (const name of ['a', 'annotate']) {
    pi.registerCommand(name, { description: 'Annotate a conversation message; Ready prepares feedback in the editor without sending.', handler });
  }
}

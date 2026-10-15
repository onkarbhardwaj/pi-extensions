import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { frame } from './frame.ts';
import { changedOnDisk, saveMdFile, type MdFile } from './md-file.ts';
import { MarkdownEditor, TextBuffer } from './md-editor.ts';
import { MarkdownPreview } from './md-preview.ts';
import { safeText } from './core.ts';

export type Mode = 'edit' | 'split' | 'preview';
type Control = 'editor' | 'save' | 'close' | Mode;

const BUTTONS: [Control, string][] = [['save', '[Save]'], ['close', '[Close]'], ['edit', '[Edit]'], ['split', '[Split]'], ['preview', '[Preview]']];
/** Below this panel width, split view starts as editor only. */
export const SPLIT_MIN_WIDTH = 100;
export const PREVIEW_INTERVAL_MS = 150;

/** The /md panel: an editor beside a live preview, in the reference reader's frame and colours. */
export function mdPanel(tui: any, theme: any, done: () => void, opened: MdFile) {
  let file = opened, savedText = file.text.replace(/\r\n/g, '\n');
  const buffer = new TextBuffer(file.text);
  const editor = new MarkdownEditor(buffer, {
    text: s => s, cursor: s => theme.style(s, { inverse: true }), muted: s => theme.fg('muted', s),
  });
  const preview = new MarkdownPreview();
  preview.setText(buffer.text);
  let mode: Mode | undefined, focused: Control = 'editor', componentFocused = false;
  let status = file.exists ? '' : 'New file · created when you save.';
  let confirmDiscard = false, confirmOverwrite = false, busy = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let regions: { x: number; y: number; width: number; action: Control }[] = [];
  let editorBox = { x: 0, y: 0, width: 0, height: 0 };
  const redraw = () => { if (!closed) tui.requestRender(); };
  const dirty = () => buffer.text !== savedText;

  // Refresh at most every PREVIEW_INTERVAL_MS while typing, rather than waiting for a pause.
  editor.onChange = () => {
    confirmDiscard = false; confirmOverwrite = false;
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; preview.setText(buffer.text); redraw(); }, PREVIEW_INTERVAL_MS);
  };

  const close = () => { closed = true; if (timer) clearTimeout(timer); done(); };
  const focusEditor = () => { focused = mode === 'preview' ? 'save' : 'editor'; editor.focused = componentFocused && focused === 'editor'; };

  async function save() {
    if (busy) return;
    busy = true; redraw();
    try {
      if (!confirmOverwrite && await changedOnDisk(file)) {
        confirmOverwrite = true;
        status = 'File changed on disk since it was opened. Save again to overwrite it.';
        return;
      }
      const text = buffer.text;
      file = await saveMdFile(file, text);
      savedText = text; confirmOverwrite = false; confirmDiscard = false;
      status = 'Saved.';
    } catch (error) { status = `Save failed: ${(error as Error).message}`; }
    finally { busy = false; redraw(); }
  }

  function activate(action: Control) {
    if (action === 'save') void save();
    else if (action === 'close') requestClose();
    else if (action === 'editor') focusEditor();
    else { mode = action; focused = action === 'preview' ? 'preview' : 'editor'; editor.focused = componentFocused && focused === 'editor'; }
    redraw();
  }

  function requestClose() {
    if (!dirty() || confirmDiscard) return close();
    confirmDiscard = true;
    status = 'Unsaved changes. Press Esc again to discard them, or Save.';
  }

  const order = (): Control[] => [...(mode === 'preview' ? [] : ['editor' as Control]), ...BUTTONS.map(([action]) => action)];

  return frame({
    get focused() { return componentFocused; },
    set focused(value: boolean) { componentFocused = value; editor.focused = value && focused === 'editor'; },
    invalidate() { preview.invalidate(); regions = []; },
    dispose() { closed = true; if (timer) clearTimeout(timer); },
    render(width: number) {
      mode ??= width >= SPLIT_MIN_WIDTH ? 'split' : 'edit';
      if (mode === 'preview' && focused === 'editor') focused = 'preview';
      const bg = theme.colors.toolPendingBg, fg = theme.colors.text;
      const paint = (text: string, columns: number, options: any = {}) => {
        const clipped = truncateToWidth(text, Math.max(0, columns));
        return theme.style(clipped + ' '.repeat(Math.max(0, columns - visibleWidth(clipped))), { fg, bg, ...options });
      };
      const name = safeText(file.path.split('/').pop() ?? file.path);
      const flags = `${dirty() ? ' ●' : ''}${file.exists ? '' : ' · new'}`;
      const result = [
        paint(` Markdown · ${name}${flags}`, width, { bold: true }),
        paint(` ${safeText(file.path)}`, width, { fg: 'muted' }),
        paint('', width),
      ];
      const height = Math.max(3, Math.floor(tui.terminal.rows * .9) - 8);
      const inner = Math.max(1, width - 2);
      const leftWidth = mode === 'split' ? Math.floor((inner - 2) / 2) : mode === 'edit' ? inner : 0;
      const rightX = mode === 'split' ? 1 + leftWidth + 2 : 1;
      const rightWidth = mode === 'split' ? inner - leftWidth - 2 : mode === 'preview' ? inner : 0;
      editor.height = height;
      const left = leftWidth ? editor.render(leftWidth) : [];
      const right = rightWidth ? preview.render(rightWidth, height, editor.progress) : [];
      editorBox = { x: 1, y: result.length, width: leftWidth, height };
      for (let y = 0; y < height; y++) {
        let row = paint(' ', 1);
        if (leftWidth) row += paint(left[y] ?? '', leftWidth);
        if (mode === 'split') row += paint(' │', 2, { fg: 'muted' });
        if (rightWidth) row += paint(right[y] ?? '', rightWidth);
        result.push(row + paint(' ', 1));
      }
      result.push(paint('', width));
      regions = [];
      let line = ' ', x = 1;
      for (const [action, text] of BUTTONS) {
        if (x + text.length + 1 > width) break;
        regions.push({ x, y: result.length, width: text.length, action });
        const current = action === mode;
        line += paint(text, text.length, focused === action ? { inverse: true, bold: true } : current ? { fg: 'accent', bold: true } : {}) + paint(' ', 1);
        x += text.length + 1;
      }
      result.push(line + paint('', Math.max(0, width - x)));
      const hint = width >= 70 ? 'Tab: focus · Enter: newline or button · Ctrl+Z: undo · Esc: close' : 'Tab: focus · Esc: close';
      result.push(paint(` ${busy ? 'Saving…' : status || hint}`, width, status ? {} : { fg: 'muted' }));
      return result;
    },
    handleInput(data: string) {
      if (busy) return;
      if (matchesKey(data, Key.escape)) { requestClose(); redraw(); return; }
      confirmDiscard = false;
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
        const list = order(), step = matchesKey(data, Key.tab) ? 1 : -1;
        focused = list[(list.indexOf(focused) + step + list.length) % list.length];
        editor.focused = componentFocused && focused === 'editor';
        status = ''; redraw(); return;
      }
      if (focused !== 'editor') {
        if (matchesKey(data, Key.enter) || data === ' ') { activate(focused); return; }
        // In preview mode, line and page keys move the hidden cursor, which scrolls the preview.
        if (mode === 'preview' && editor.handleNavigation(data)) redraw();
        return;
      }
      editor.handleInput(data);
      if (status && status !== 'Saved.' && !status.startsWith('Save failed')) status = '';
      redraw();
    },
    handleMouse(event: any) {
      if (busy) return { handled: true };
      const inEditor = event.x >= editorBox.x && event.x < editorBox.x + editorBox.width && event.y >= editorBox.y && event.y < editorBox.y + editorBox.height;
      if (event.type === 'wheel') { editor.scrollBy(event.wheelDelta ?? 0); redraw(); return { handled: true }; }
      if (event.type !== 'click' || event.button !== 'left') return;
      const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
      if (hit) { focused = hit.action; editor.focused = false; activate(hit.action); return { handled: true }; }
      if (inEditor) {
        focused = 'editor'; editor.focused = componentFocused;
        editor.clickAt(event.x - editorBox.x, event.y - editorBox.y); redraw();
        return { handled: true };
      }
    },
  }, theme);
}

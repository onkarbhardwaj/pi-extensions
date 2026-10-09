import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Marked, Input, Key, matchesKey, visibleWidth, truncateToWidth, sliceByColumn, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { frame } from './frame.ts';
import { stripVTControlCharacters } from 'node:util';
import { diagramMarkdown } from './mermaid.ts';
import { excerpt, feedback, labels, safeText, renderedMatches, type Snapshot, type Note } from './core.ts';

type Options = {
  files: Snapshot[]; selected?: string;
  add: (path: string) => Promise<Snapshot>;
  remove: (path: string) => Promise<void>;
  refresh: (path: string) => Promise<Snapshot>;
};

export function reader(tui: any, theme: any, done: (result?: string) => void, options: Options) {
  const files = [...options.files], notes: Note[] = [];
  let fileIndex = Math.max(0, files.findIndex(f => f.path === options.selected));
  let listScroll = 0, scroll = 0, cursor = 0, anchor: number | undefined;
  let viewWidth = 0, rows: string[] = [], maxScroll = 0, height = 1;
  let listWidth = 0, preferredWidth: number | undefined;
  let focused = 'files', componentFocused = false, entering: 'comment' | 'path' | undefined;
  let editing: number | undefined, pending: Omit<Note, 'comment'> | undefined;
  let status = '', busy = false, closed = false, reveal = false, dragging = false;
  let regions: any[] = [], divider = -1;
  let markdown: Markdown | undefined, cachedPath: string | undefined, cachedHash: string | undefined;
  const input = new Input({ prompt: '' }), parser = new Marked();
  const search = new Input({ prompt: 'Search: ' });
  let searching = false, query = '', searchKey = '', matchIndex = 0, seekMatch = false;
  let matches: { row: number; start: number; end: number }[] = [];
  const matchRows = new Map<number, number[]>();
  const redraw = () => tui.requestRender();
  const beginSearch = () => { searching = true; search.focused = componentFocused; redraw(); };
  const finishSearch = () => { searching = false; search.focused = false; focused = 'content'; redraw(); };
  search.onSubmit = finishSearch; search.onEscape = finishSearch;
  const nextMatch = (delta: number) => {
    if (matches.length) { matchIndex = (matchIndex + delta + matches.length) % matches.length; seekMatch = true; reveal = false; }
    redraw();
  };
  const current = () => files[fileIndex];
  const fileNotes = () => notes.map((note, index) => ({ note, index })).filter(n => n.note.path === current()?.path);
  const controls = () => ['files', 'content', 'search', 'comment', ...fileNotes().flatMap(n => [`edit:${n.index}`, `delete:${n.index}`]), 'add', 'refresh', 'remove', 'ready', 'cancel'];
  const choose = (index: number) => {
    fileIndex = Math.max(0, Math.min(files.length - 1, index));
    scroll = 0; cursor = 0; anchor = undefined; markdown = undefined; rows = []; status = ''; reveal = false;
    searchKey = ''; matchIndex = 0; seekMatch = !!query;
    listScroll = Math.max(0, Math.min(listScroll, fileIndex));
    if (fileIndex >= listScroll + height) listScroll = Math.max(0, fileIndex - height + 1);
    redraw();
  };
  const close = (result?: string) => { closed = true; done(result); };
  const comment = (index?: number) => {
    if (index === undefined) {
      const file = current();
      if (!file || file.error || file.text === undefined || !file.hash) throw new Error('Choose a readable Markdown file.');
      pending = { path: file.path, name: file.name, hash: file.hash, excerpt: excerpt(rows, anchor, cursor) };
    } else { pending = notes[index]; }
    editing = index; entering = 'comment'; input.setValue(index === undefined ? '' : notes[index].comment);
    input.focused = componentFocused; status = 'Comment · Enter saves; Escape discards this input.'; redraw();
  };
  async function activate(action: string) {
    if (busy || closed) return;
    try {
      if (action === 'files' || action === 'content') { focused = action; redraw(); }
      else if (action === 'search') beginSearch();
      else if (action === 'comment') comment();
      else if (action.startsWith('edit:')) comment(Number(action.split(':')[1]));
      else if (action.startsWith('delete:')) { notes.splice(Number(action.split(':')[1]), 1); focused = 'comment'; redraw(); }
      else if (action === 'add') { entering = 'path'; input.setValue(''); input.focused = componentFocused; status = 'Markdown path · Enter adds; Escape cancels.'; redraw(); }
      else if (action === 'cancel') close();
      else if (action === 'ready') close(feedback(notes));
      else if (action === 'remove' && current()) {
        busy = true; const path = current().path;
        await options.remove(path); if (closed) return;
        files.splice(fileIndex, 1); choose(fileIndex);
        // Comments explicitly collected in this review are retained for Ready.
        status = 'Reference removed; file and saved comments untouched.';
      } else if (action === 'refresh' && current()) {
        busy = true; const index = fileIndex, file = await options.refresh(current().path); if (closed) return;
        files[index] = file; choose(index); status = 'Refreshed. Saved excerpts retain their original text.';
      }
    } catch (error) { status = (error as Error).message; }
    finally { busy = false; if (!closed) redraw(); }
  }
  input.onSubmit = value => {
    if (!value.trim() || busy) return;
    if (entering === 'comment' && pending) {
      const note = { ...pending, comment: value };
      if (editing === undefined) notes.push(note); else notes[editing] = note;
      entering = undefined; input.focused = false; editing = undefined; pending = undefined;
      status = 'Comment saved. Ready prepares the editor draft; it does not send.'; redraw();
    } else if (entering === 'path') {
      busy = true;
      void options.add(value).then(file => {
        if (closed) return;
        const existing = files.findIndex(f => f.path === file.path);
        if (existing < 0) files.push(file);
        entering = undefined; input.focused = false; choose(existing < 0 ? files.length - 1 : existing);
      }).catch(error => { status = error.message; }).finally(() => { busy = false; if (!closed) redraw(); });
    }
  };
  input.onEscape = () => { if (busy) return; entering = undefined; input.focused = false; pending = undefined; editing = undefined; status = ''; redraw(); };

  return frame({
    get focused() { return componentFocused; },
    set focused(value: boolean) { componentFocused = value; input.focused = value && !!entering; search.focused = value && searching; },
    invalidate() { markdown?.invalidate(); input.invalidate(); search.invalidate(); searchKey = ''; regions = []; },
    dispose() { closed = true; },
    render(width: number) {
      const available = Math.max(1, width - 2);
      listWidth = width >= 38 ? Math.min(Math.max(12, preferredWidth ?? Math.floor(available * .27)), Math.max(12, available - 22)) : 0;
      const rightX = 1 + (listWidth ? listWidth + 2 : 0), rightWidth = Math.max(1, width - rightX - 1);
      if (rightWidth !== viewWidth) { if (viewWidth && anchor !== undefined) status = 'Layout changed; select again. Saved comments are unchanged.'; viewWidth = rightWidth; anchor = undefined; cursor = 0; reveal = false; }
      const file = current();
      if (file?.text !== undefined && !file.error) {
        if (!markdown || cachedPath !== file.path || cachedHash !== file.hash) {
          markdown = new Markdown(safeText(file.text.replace(/\r\n/g, '\n')), 0, 0, getMarkdownTheme(), undefined, {
            transform: (text, columns) => parser.lexer(text).map(token => token.type === 'code' && token.lang?.trim().toLowerCase() === 'mermaid'
              ? diagramMarkdown(token.text, token.raw, columns) : token.raw).join(''),
          }); cachedPath = file.path; cachedHash = file.hash;
        }
        rows = markdown.render(rightWidth);
      } else rows = [];
      const key = JSON.stringify([file?.path, file?.hash, rightWidth, query]);
      if (key !== searchKey) {
        matches = renderedMatches(rows, query); matchIndex = Math.min(matchIndex, Math.max(0, matches.length - 1)); searchKey = key;
        matchRows.clear(); matches.forEach((hit, i) => { const items = matchRows.get(hit.row) ?? []; items.push(i); matchRows.set(hit.row, items); });
      }
      const content: any[] = rows.map((text, index) => ({ text, index }));
      if (!rows.length) content.push({ text: file?.error ? safeText(file.error) : file ? '(Empty Markdown file)' : 'Add a Markdown file with /ref <path> or Add file.' });
      const activeNotes = fileNotes();
      if (activeNotes.length) content.push({ text: '' }, { text: 'Comments on this file', bold: true });
      for (const { note, index } of activeNotes) {
        content.push(...wrapTextWithAnsi(safeText(note.excerpt), rightWidth).map(text => ({ text })));
        content.push(...wrapTextWithAnsi(safeText(note.comment), rightWidth).map(text => ({ text, bold: true })));
        content.push({ text: '[ Edit ]  [ Delete ]', actions: [{ x: 0, width: 8, action: `edit:${index}` }, { x: 10, width: 10, action: `delete:${index}` }] });
      }
      let footerRows = 1, footerColumn = 1;
      if (!entering) for (const text of ['[Comment]', '[+ File]', '[Refresh]', '[Remove]', '[Ready]', '[Cancel]']) {
        if (footerColumn > 1 && footerColumn + text.length + 1 > width) { footerRows++; footerColumn = 1; }
        footerColumn += Math.min(text.length, Math.max(0, width - footerColumn)) + 1;
      }
      height = Math.max(1, Math.floor(tui.terminal.rows * .9) - 9 - footerRows);
      maxScroll = Math.max(0, content.length - height);
      cursor = Math.max(0, Math.min(cursor, rows.length - 1));
      if (reveal) {
        const at = focused.startsWith('edit:') || focused.startsWith('delete:') ? content.findIndex(r => r.actions?.some(a => a.action === focused)) : cursor;
        if (at < scroll) scroll = Math.max(0, at); else if (at >= scroll + height) scroll = at - height + 1;
        reveal = false;
      }
      if (seekMatch) { const hit = matches[matchIndex]; if (hit) scroll = Math.max(0, hit.row - Math.floor(height / 2)); seekMatch = false; }
      scroll = Math.max(0, Math.min(scroll, maxScroll)); listScroll = Math.max(0, Math.min(listScroll, Math.max(0, files.length - height)));
      const names = labels(files.map(f => f.path));
      const bg = theme.colors.toolPendingBg, fg = theme.colors.text, selectedBg = theme.colors.userMessageBg;
      const paint = (text: string, columns: number, options: any = {}) => {
        const clipped = truncateToWidth(text, Math.max(0, columns));
        return theme.style(clipped + ' '.repeat(Math.max(0, columns - visibleWidth(clipped))), { fg, bg, ...options });
      };
      const count = query ? ` ${matches.length ? matchIndex + 1 : 0}/${matches.length}${entering ? '' : ' p← →n'}` : '';
      const searchWidth = Math.min(Math.max(12, Math.floor(width * .45)), Math.max(1, width - 1));
      const searchX = Math.max(0, width - searchWidth);
      const countWidth = Math.min(visibleWidth(count), Math.max(0, searchWidth - 9));
      const fieldWidth = Math.max(1, searchWidth - countWidth);
      const field = searching ? search.render(fieldWidth).join('') : truncateToWidth(`Search: ${query || '/'}`, fieldWidth);
      const result = [paint(` References · ${files.length} files · ${notes.length} comments`, searchX, { bold: true })
        + paint(field, fieldWidth) + paint(count, countWidth),
        paint(` ${names[fileIndex] ?? 'No reference selected'}${files.length ? `  (${fileIndex + 1}/${files.length})` : ''}`, width), paint('', width)];
      regions = [{ x: searchX, y: 0, width: searchWidth, action: 'search' }]; divider = listWidth ? listWidth + 2 : -1;
      const bodyHeight = Math.min(height, Math.max(1, content.length - scroll, Math.min(height, files.length - listScroll)));
      for (let y = 0; y < bodyHeight; y++) {
        let left = '';
        if (listWidth) {
          const index = listScroll + y, item = files[index];
          if (item) regions.push({ x: 1, y: result.length, width: listWidth, file: index });
          const count = item ? notes.filter(n => n.path === item.path).length : 0;
          left = paint(item ? `${index === fileIndex ? '›' : ' '} ${names[index]}${count ? ` ·${count}` : ''}` : '', listWidth,
            { bg: index === fileIndex ? selectedBg : bg, bold: index === fileIndex && focused === 'files' }) + paint(' │', 2);
        }
        const row = content[scroll + y] ?? { text: '' };
        if (row.index !== undefined) regions.push({ x: rightX, y: result.length, width: rightWidth, line: row.index });
        const selected = anchor !== undefined && row.index !== undefined && row.index >= Math.min(anchor, cursor) && row.index <= Math.max(anchor, cursor);
        let right = paint(row.text, rightWidth, { bg: selected ? selectedBg : bg, bold: row.bold });
        if (row.index !== undefined && query) {
          const plain = stripVTControlCharacters(row.text);
          for (const i of [...(matchRows.get(row.index) ?? [])].reverse()) {
            const hit = matches[i];
            const x = visibleWidth(plain.slice(0, hit.start)), size = visibleWidth(plain.slice(hit.start, hit.end));
            right = sliceByColumn(right, 0, x) + theme.style(plain.slice(hit.start, hit.end), { fg, bg: theme.colors.userMessageBg, bold: true, underline: i === matchIndex })
              + sliceByColumn(right, x + size, Math.max(0, rightWidth - x - size));
          }
        }
        for (const a of row.actions ?? []) {
          if (a.x >= rightWidth) continue;
          regions.push({ x: rightX + a.x, y: result.length, width: Math.min(a.width, rightWidth - a.x), action: a.action });
          if (focused === a.action && !entering) right = paint(sliceByColumn(row.text, 0, a.x), a.x)
            + paint(sliceByColumn(row.text, a.x, a.width), Math.min(a.width, rightWidth - a.x), { inverse: true })
            + paint(sliceByColumn(row.text, a.x + a.width, rightWidth), Math.max(0, rightWidth - a.x - a.width));
        }
        result.push(paint(' ', 1) + left + right + paint(' ', 1));
      }
      result.push(paint('', width));
      if (entering) result.push(paint(' ', 1) + paint(input.render(available).join(''), available) + paint(' ', 1));
      else {
        let line = ' ', x = 1;
        for (const [action, text] of [['comment', '[Comment]'], ['add', '[+ File]'], ['refresh', '[Refresh]'], ['remove', '[Remove]'], ['ready', '[Ready]'], ['cancel', '[Cancel]']]) {
          if (x > 1 && x + text.length + 1 > width) { result.push(paint(line, width)); line = ' '; x = 1; }
          const w = Math.min(text.length, Math.max(0, width - x));
          regions.push({ x, y: result.length, width: w, action });
          line += paint(text, w, focused === action ? { inverse: true, bold: true } : {}) + ' '; x += w + 1;
        }
        result.push(paint(line, width));
      }
      result.push(paint(' ' + (busy ? 'Loading…' : status), width),
        paint(entering ? ' Enter saves · Esc back' : ' Tab: focus · ↑↓: files/text · Shift+↑↓/click: select · Enter: comment/control', width),
        paint(entering ? '' : ' ←→: file · wheel: pane scroll · [ ]: divider · Esc: cancel', width));
      return result;
    },
    handleInput(data: string) {
      if (busy) return;
      if (entering) { input.handleInput(data); redraw(); return; }
      if (searching) {
        search.handleInput(data);
        if (query !== search.getValue()) { query = search.getValue(); matchIndex = 0; seekMatch = true; }
        redraw(); return;
      }
      if (data === '/') { beginSearch(); return; }
      if (query && (data === 'n' || data === 'p')) { nextMatch(data === 'n' ? 1 : -1); return; }
      if (matchesKey(data, Key.escape)) { close(); return; }
      if (matchesKey(data, Key.tab)) { const list = controls(); focused = list[(list.indexOf(focused) + 1) % list.length]; reveal = focused.startsWith('edit:') || focused.startsWith('delete:'); redraw(); return; }
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) { choose(fileIndex + (matchesKey(data, Key.left) ? -1 : 1)); return; }
      if (data === '[' || data === ']') { preferredWidth = Math.max(12, listWidth + (data === ']' ? 4 : -4)); redraw(); return; }
      if (matchesKey(data, Key.enter)) { void activate(focused === 'content' ? 'comment' : focused); return; }
      const up = matchesKey(data, Key.up) || matchesKey(data, Key.shift('up'));
      const down = matchesKey(data, Key.down) || matchesKey(data, Key.shift('down'));
      if (up || down) {
        const extend = matchesKey(data, Key.shift('up')) || matchesKey(data, Key.shift('down'));
        if (focused === 'files' && !extend) choose(fileIndex + (up ? -1 : 1));
        else {
          focused = 'content'; if (extend && anchor === undefined) anchor = cursor;
          cursor = Math.max(0, Math.min(rows.length - 1, cursor + (up ? -1 : 1)));
          if (!extend) anchor = cursor; reveal = true; redraw();
        }
      }
    },
    handleMouse(event: any) {
      if (busy || entering) return { handled: true };
      if (searching && event.type === 'click' && event.y !== 0) finishSearch();
      if (dragging && (event.type === 'drag' || event.type === 'release')) {
        preferredWidth = Math.max(12, event.x - 2); if (event.type === 'release') dragging = false; redraw(); return { handled: true };
      }
      if (event.type === 'press' && event.button === 'left' && divider >= 0 && Math.abs(event.x - divider) <= 1 && event.y >= 3 && event.y < 3 + height) { dragging = true; return { handled: true, capture: true }; }
      if (event.type === 'wheel') {
        if (listWidth && event.x < divider) listScroll = Math.max(0, Math.min(Math.max(0, files.length - height), listScroll + (event.wheelDelta ?? 0)));
        else scroll = Math.max(0, Math.min(maxScroll, scroll + (event.wheelDelta ?? 0)));
        redraw(); return { handled: true };
      }
      if (event.type !== 'click' || event.button !== 'left') return;
      const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
      if (!hit) return;
      if (hit.file !== undefined) { focused = 'files'; choose(hit.file); }
      else if (hit.action) { focused = hit.action; void activate(hit.action); }
      else { focused = 'content'; cursor = hit.line; if (!event.shift || anchor === undefined) anchor = cursor; redraw(); }
      return { handled: true };
    },
  }, theme);
}

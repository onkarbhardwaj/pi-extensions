import { decodeKittyPrintable, getKeybindings, Key, matchesKey, visibleWidth, type Component } from '@earendil-works/pi-tui';

/** A cursor position: logical line index and UTF-16 offset within that line. */
export type Position = { line: number; col: number };
type Snapshot = { lines: string[]; cursor: Position };
type EditKind = 'type' | 'delete' | 'other';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => [...segmenter.segment(text)].map(s => s.segment);
const isWordChar = (text: string) => /[\p{L}\p{N}_]/u.test(text);
const UNDO_LIMIT = 500;

/** Converts text to editor-safe characters: Unix newlines, spaces for tabs, no control characters. */
export function normalizeText(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

/** Text, cursor, and undo history, independent of rendering. */
export class TextBuffer {
  private lines: string[];
  private cursor: Position = { line: 0, col: 0 };
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastKind: EditKind | undefined;
  private revision = 0;

  constructor(text = '') { this.lines = normalizeText(text).split('\n'); }

  get text() { return this.lines.join('\n'); }
  get lineCount() { return this.lines.length; }
  get position(): Position { return { ...this.cursor }; }
  /** Increments on every content change; cheap to compare for dirtiness and re-render decisions. */
  get version() { return this.revision; }
  line(index: number) { return this.lines[index] ?? ''; }

  setCursor(position: Position) {
    const line = Math.max(0, Math.min(this.lines.length - 1, position.line));
    const text = this.lines[line];
    // Snap to a grapheme boundary so the cursor never splits an emoji or combined character.
    let col = 0;
    for (const part of graphemes(text)) { if (col + part.length > position.col) break; col += part.length; }
    this.cursor = { line, col };
    this.lastKind = undefined;
  }

  private snapshot(kind: EditKind) {
    // Consecutive typing or deleting forms one undo step; any other action starts a new one.
    if (kind !== 'other' && kind === this.lastKind) return;
    this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.lastKind = kind;
  }

  private changed() { this.revision++; }

  insert(text: string) {
    const clean = normalizeText(text);
    if (!clean) return;
    this.snapshot([...clean].length === 1 && clean !== '\n' ? 'type' : 'other');
    const { line, col } = this.cursor, current = this.lines[line];
    const parts = clean.split('\n');
    const before = current.slice(0, col), after = current.slice(col);
    if (parts.length === 1) {
      this.lines[line] = before + clean + after;
      this.cursor = { line, col: col + clean.length };
    } else {
      const last = parts[parts.length - 1];
      this.lines.splice(line, 1, before + parts[0], ...parts.slice(1, -1), last + after);
      this.cursor = { line: line + parts.length - 1, col: last.length };
    }
    this.changed();
  }

  private previousBoundary(text: string, col: number) {
    let at = 0;
    for (const part of graphemes(text.slice(0, col))) { if (at + part.length >= col) break; at += part.length; }
    return at;
  }

  private nextBoundary(text: string, col: number) {
    const part = graphemes(text.slice(col))[0];
    return part ? col + part.length : col;
  }

  private wordLeft(): Position {
    let { line, col } = this.cursor;
    if (col === 0) return line > 0 ? { line: line - 1, col: this.lines[line - 1].length } : { line, col };
    const parts = graphemes(this.lines[line].slice(0, col));
    let i = parts.length;
    while (i > 0 && !isWordChar(parts[i - 1])) i--;
    while (i > 0 && isWordChar(parts[i - 1])) i--;
    return { line, col: parts.slice(0, i).join('').length };
  }

  private wordRight(): Position {
    const { line, col } = this.cursor, text = this.lines[line];
    if (col >= text.length) return line < this.lines.length - 1 ? { line: line + 1, col: 0 } : { line, col };
    const parts = graphemes(text.slice(col));
    let i = 0;
    while (i < parts.length && !isWordChar(parts[i])) i++;
    while (i < parts.length && isWordChar(parts[i])) i++;
    return { line, col: col + parts.slice(0, i).join('').length };
  }

  private deleteRange(from: Position, to: Position, kind: EditKind) {
    const [start, end] = from.line < to.line || (from.line === to.line && from.col <= to.col) ? [from, to] : [to, from];
    if (start.line === end.line && start.col === end.col) return;
    this.snapshot(kind);
    const head = this.lines[start.line].slice(0, start.col), tail = this.lines[end.line].slice(end.col);
    this.lines.splice(start.line, end.line - start.line + 1, head + tail);
    this.cursor = { ...start };
    this.changed();
  }

  backspace() {
    const { line, col } = this.cursor;
    if (col > 0) this.deleteRange({ line, col: this.previousBoundary(this.lines[line], col) }, this.cursor, 'delete');
    else if (line > 0) this.deleteRange({ line: line - 1, col: this.lines[line - 1].length }, this.cursor, 'delete');
  }

  deleteForward() {
    const { line, col } = this.cursor, text = this.lines[line];
    if (col < text.length) this.deleteRange(this.cursor, { line, col: this.nextBoundary(text, col) }, 'delete');
    else if (line < this.lines.length - 1) this.deleteRange(this.cursor, { line: line + 1, col: 0 }, 'delete');
  }

  deleteWordBackward() { this.deleteRange(this.wordLeft(), this.cursor, 'other'); }
  deleteWordForward() { this.deleteRange(this.cursor, this.wordRight(), 'other'); }
  deleteToLineStart() { this.deleteRange({ line: this.cursor.line, col: 0 }, this.cursor, 'other'); }
  deleteToLineEnd() {
    const { line } = this.cursor;
    this.deleteRange(this.cursor, { line, col: this.lines[line].length }, 'other');
  }

  moveLeft() {
    const { line, col } = this.cursor;
    this.setCursor(col > 0 ? { line, col: this.previousBoundary(this.lines[line], col) }
      : line > 0 ? { line: line - 1, col: this.lines[line - 1].length } : this.cursor);
  }
  moveRight() {
    const { line, col } = this.cursor, text = this.lines[line];
    this.setCursor(col < text.length ? { line, col: this.nextBoundary(text, col) }
      : line < this.lines.length - 1 ? { line: line + 1, col: 0 } : this.cursor);
  }
  moveWordLeft() { this.setCursor(this.wordLeft()); }
  moveWordRight() { this.setCursor(this.wordRight()); }
  moveLineStart() { this.setCursor({ line: this.cursor.line, col: 0 }); }
  moveLineEnd() { this.setCursor({ line: this.cursor.line, col: this.lines[this.cursor.line].length }); }

  undo() { this.restoreFrom(this.undoStack, this.redoStack); }
  redo() { this.restoreFrom(this.redoStack, this.undoStack); }
  private restoreFrom(from: Snapshot[], to: Snapshot[]) {
    const state = from.pop();
    if (!state) return;
    to.push({ lines: [...this.lines], cursor: { ...this.cursor } });
    this.lines = state.lines; this.cursor = state.cursor; this.lastKind = undefined;
    this.changed();
  }
}

/** One screen row of a soft-wrapped logical line: `start`/`end` are UTF-16 offsets into that line. */
export type VisualRow = { line: number; start: number; end: number; text: string };

/** Soft-wraps lines to `width` columns, breaking after spaces when possible and inside long words otherwise. */
export function layoutRows(buffer: TextBuffer, width: number): VisualRow[] {
  const rows: VisualRow[] = [], limit = Math.max(1, width);
  for (let line = 0; line < buffer.lineCount; line++) {
    const parts = graphemes(buffer.line(line));
    if (!parts.length) { rows.push({ line, start: 0, end: 0, text: '' }); continue; }
    let start = 0, i = 0;
    while (i < parts.length) {
      let used = 0, j = i, lastBreak = -1;
      while (j < parts.length && used + visibleWidth(parts[j]) <= limit) {
        used += visibleWidth(parts[j]);
        if (parts[j] === ' ') lastBreak = j + 1;
        j++;
      }
      if (j === i) j = i + 1;
      else if (j < parts.length && lastBreak > i) j = lastBreak;
      const text = parts.slice(i, j).join('');
      rows.push({ line, start, end: start + text.length, text });
      start += text.length; i = j;
    }
  }
  return rows;
}

/** Index of the visual row holding the cursor; at a wrap point the cursor belongs to the next row. */
export function cursorRow(rows: VisualRow[], cursor: Position) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], next = rows[i + 1];
    if (row.line !== cursor.line) continue;
    const continues = next?.line === row.line;
    if (cursor.col < row.end || (cursor.col === row.end && !continues)) return i;
  }
  return Math.max(0, rows.length - 1);
}

/** Offset in `row` closest to display column `x`, never splitting a grapheme. */
export function colAtX(row: VisualRow, x: number) {
  let used = 0, col = row.start;
  for (const part of graphemes(row.text)) {
    const size = visibleWidth(part);
    if (used + size > x) break;
    used += size; col += part.length;
  }
  return col;
}

type EditorStyle = { text: (s: string) => string; cursor: (s: string) => string; muted: (s: string) => string };

/**
 * A multi-line document editor that fills whatever height its owner gives it.
 * Keys follow Pi's configured editor keybindings; Enter inserts a newline.
 * Tab and Escape are left to the owning panel.
 */
export class MarkdownEditor implements Component {
  focused = false;
  height = 10;
  onChange?: () => void;
  private scroll = 0;
  private goalX: number | undefined;
  private width = 1;
  private pasting: string | undefined;

  readonly buffer: TextBuffer;
  private readonly style: EditorStyle;

  constructor(buffer: TextBuffer, style: EditorStyle) {
    this.buffer = buffer;
    this.style = style;
  }

  invalidate() {}

  /** Fraction of the document above the cursor, used to keep a preview roughly in step. */
  get progress() { return this.buffer.lineCount > 1 ? this.buffer.position.line / (this.buffer.lineCount - 1) : 0; }

  private rows() { return layoutRows(this.buffer, this.width); }

  render(width: number): string[] {
    this.width = Math.max(1, width);
    const rows = this.rows(), at = cursorRow(rows, this.buffer.position), height = Math.max(1, this.height);
    if (at < this.scroll) this.scroll = at;
    else if (at >= this.scroll + height) this.scroll = at - height + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - height)));
    const out: string[] = [];
    for (let y = 0; y < height; y++) {
      const index = this.scroll + y, row = rows[index];
      if (!row) { out.push(''); continue; }
      if (index !== at || !this.focused) { out.push(this.style.text(row.text)); continue; }
      const offset = this.buffer.position.col - row.start;
      const before = row.text.slice(0, offset), rest = row.text.slice(offset);
      const under = graphemes(rest)[0] ?? ' ';
      const line = this.style.text(before) + this.style.cursor(under) + this.style.text(rest.slice(rest ? under.length : 0));
      out.push(line);
    }
    return out;
  }

  private moveVertical(delta: number) {
    const rows = this.rows(), at = cursorRow(rows, this.buffer.position), row = rows[at];
    const x = this.goalX ?? visibleWidth(row.text.slice(0, this.buffer.position.col - row.start));
    const target = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
    this.buffer.setCursor({ line: target.line, col: colAtX(target, x) });
    this.goalX = x;
  }

  /** Places the cursor at a display position inside the editor (for mouse clicks). */
  clickAt(x: number, y: number) {
    const rows = this.rows(), row = rows[Math.min(rows.length - 1, this.scroll + Math.max(0, y))];
    if (!row) return;
    this.buffer.setCursor({ line: row.line, col: colAtX(row, x) });
    this.goalX = undefined;
  }

  scrollBy(delta: number) {
    const rows = this.rows().length;
    this.scroll = Math.max(0, Math.min(Math.max(0, rows - this.height), this.scroll + delta));
    // Keep the cursor visible so the next render does not snap the view back.
    const at = cursorRow(this.rows(), this.buffer.position);
    if (at < this.scroll || at >= this.scroll + this.height) this.clickAt(0, at < this.scroll ? 0 : this.height - 1);
  }

  handleInput(data: string) {
    const before = this.buffer.version;
    if (this.handleNavigation(data)) return;
    // Bracketed paste can arrive split across several input chunks.
    if (this.pasting !== undefined || data.includes('\x1b[200~')) {
      this.pasting = (this.pasting ?? '') + data.replace('\x1b[200~', '');
      const end = this.pasting.indexOf('\x1b[201~');
      if (end < 0) return;
      const text = this.pasting.slice(0, end);
      this.pasting = undefined;
      this.buffer.insert(text);
      this.finish(before, false);
      return;
    }
    const kb = getKeybindings();
    const is = (name: Parameters<typeof kb.matches>[1]) => kb.matches(data, name);
    let vertical = false;
    if (is('tui.input.submit') || is('tui.input.newLine')) this.buffer.insert('\n');
    else if (is('tui.editor.cursorWordLeft')) this.buffer.moveWordLeft();
    else if (is('tui.editor.cursorWordRight')) this.buffer.moveWordRight();
    else if (is('tui.editor.cursorLeft')) this.buffer.moveLeft();
    else if (is('tui.editor.cursorRight')) this.buffer.moveRight();
    else if (is('tui.editor.cursorLineStart')) this.buffer.moveLineStart();
    else if (is('tui.editor.cursorLineEnd')) this.buffer.moveLineEnd();
    else if (is('tui.editor.deleteWordBackward')) this.buffer.deleteWordBackward();
    else if (is('tui.editor.deleteWordForward')) this.buffer.deleteWordForward();
    else if (is('tui.editor.deleteToLineStart')) this.buffer.deleteToLineStart();
    else if (is('tui.editor.deleteToLineEnd')) this.buffer.deleteToLineEnd();
    else if (is('tui.editor.deleteCharBackward')) this.buffer.backspace();
    else if (is('tui.editor.deleteCharForward')) this.buffer.deleteForward();
    else if (is('tui.editor.undo') || matchesKey(data, Key.ctrl('z'))) this.buffer.undo();
    else if (matchesKey(data, Key.ctrlShift('z'))) this.buffer.redo();
    else {
      const printable = decodeKittyPrintable(data) ?? (!data.includes('\x1b') && [...data].every(c => c.charCodeAt(0) >= 32) ? data : undefined);
      if (printable === undefined) return;
      this.buffer.insert(printable);
    }
    this.finish(before, vertical);
  }

  private finish(before: number, vertical: boolean) {
    if (!vertical) this.goalX = undefined;
    if (this.buffer.version !== before) this.onChange?.();
  }

  /** Handles only line and page movement; returns false for any other key. Usable while the text is read-only. */
  handleNavigation(data: string) {
    const kb = getKeybindings(), page = Math.max(1, this.height - 1);
    const delta = kb.matches(data, 'tui.editor.cursorUp') ? -1 : kb.matches(data, 'tui.editor.cursorDown') ? 1
      : kb.matches(data, 'tui.editor.pageUp') ? -page : kb.matches(data, 'tui.editor.pageDown') ? page : 0;
    if (!delta) return false;
    this.moveVertical(delta);
    return true;
  }
}

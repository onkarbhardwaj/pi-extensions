import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownEditor, TextBuffer, colAtX, cursorRow, layoutRows, normalizeText } from '../src/md-editor.ts';

const style = { text: (s: string) => s, cursor: (s: string) => `[${s}]`, muted: (s: string) => s };
const typed = (buffer: TextBuffer, text: string) => { for (const c of text) buffer.insert(c); };

test('text is normalized and edits split and join lines', () => {
  assert.equal(normalizeText('a\r\nb\tc\x07'), 'a\nb  c');
  const buffer = new TextBuffer('hello world');
  buffer.setCursor({ line: 0, col: 5 });
  buffer.insert('\n');
  assert.equal(buffer.text, 'hello\n world');
  assert.deepEqual(buffer.position, { line: 1, col: 0 });
  buffer.backspace();
  assert.equal(buffer.text, 'hello world');
  buffer.insert('a\nb\nc');
  assert.equal(buffer.text, 'helloa\nb\nc world');
  assert.deepEqual(buffer.position, { line: 2, col: 1 });
});

test('cursor movement and deletion never split emoji or accented characters', () => {
  const buffer = new TextBuffer('a👍🏽é b');
  buffer.moveLineEnd();
  buffer.moveLeft(); buffer.moveLeft(); buffer.moveLeft();
  assert.equal(buffer.text.slice(0, buffer.position.col), 'a👍🏽');
  buffer.backspace();
  assert.equal(buffer.text, 'aé b');
  buffer.setCursor({ line: 0, col: 2 });
  assert.equal(buffer.position.col, 2);
  const decomposed = new TextBuffer('ae\u0301');
  decomposed.setCursor({ line: 0, col: 2 });
  assert.equal(decomposed.position.col, 1, 'a cursor inside a combined character snaps to its start');
});

test('word motions and line deletions behave like a text editor', () => {
  const buffer = new TextBuffer('one, two three');
  buffer.moveLineEnd();
  buffer.moveWordLeft();
  assert.equal(buffer.position.col, 9);
  buffer.moveWordLeft();
  assert.equal(buffer.position.col, 5);
  buffer.deleteWordBackward();
  assert.equal(buffer.text, 'two three');
  buffer.moveWordRight();
  buffer.deleteToLineEnd();
  assert.equal(buffer.text, 'two');
});

test('typing undoes as one step; redo restores; a new edit clears redo', () => {
  const buffer = new TextBuffer('');
  typed(buffer, 'hello');
  buffer.insert('\n');
  typed(buffer, 'world');
  buffer.undo();
  assert.equal(buffer.text, 'hello\n');
  buffer.undo();
  assert.equal(buffer.text, 'hello');
  buffer.undo();
  assert.equal(buffer.text, '');
  buffer.redo();
  assert.equal(buffer.text, 'hello');
  typed(buffer, '!');
  buffer.redo();
  assert.equal(buffer.text, 'hello!');
});

test('soft wrapping prefers spaces, keeps wide characters whole, and maps the cursor', () => {
  const rows = layoutRows(new TextBuffer('alpha beta gamma\n\n世界世界'), 7);
  assert.deepEqual(rows.map(r => r.text), ['alpha ', 'beta ', 'gamma', '', '世界世', '界']);
  assert.equal(cursorRow(rows, { line: 0, col: 6 }), 1, 'the wrap point belongs to the next row');
  assert.equal(cursorRow(rows, { line: 0, col: 16 }), 2);
  assert.equal(colAtX(rows[4], 3), 1, 'a click on the second half of a wide character lands before it');
});

test('editor fills its height, keeps the cursor visible, and preserves column on vertical moves', () => {
  const editor = new MarkdownEditor(new TextBuffer(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')), style);
  editor.focused = true;
  editor.height = 5;
  assert.equal(editor.render(20).length, 5);
  editor.buffer.setCursor({ line: 12, col: 6 });
  const lines = editor.render(20);
  assert.ok(lines.some(line => line.includes('line 1[2]')));
  const short = new MarkdownEditor(new TextBuffer('abcdef\nab\nabcdef'), style);
  short.buffer.setCursor({ line: 0, col: 5 });
  short.render(20);
  short.handleInput('\x1b[B'); short.handleInput('\x1b[B');
  assert.deepEqual(short.buffer.position, { line: 2, col: 5 });
});

test('Enter inserts a newline, printable keys type, and split bracketed paste arrives intact', () => {
  const editor = new MarkdownEditor(new TextBuffer(''), style);
  let changes = 0;
  editor.onChange = () => { changes++; };
  editor.handleInput('a');
  editor.handleInput('\r');
  editor.handleInput('\x1b[200~line one\nline');
  assert.equal(editor.buffer.text, 'a\n');
  editor.handleInput(' two\x1b[201~');
  assert.equal(editor.buffer.text, 'a\nline one\nline two');
  editor.handleInput('\x1b[A');
  assert.equal(changes, 3);
});

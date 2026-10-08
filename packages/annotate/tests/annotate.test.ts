import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFromEntry, selectRange, feedback, appendDraft, safeText, sourceRows } from '../src/core.mjs';

test('eligible user and assistant text can be selected without changing the source entry', () => {
  for (const role of ['user', 'assistant']) {
    const entry = { id: 'message-1', type: 'message', message: { role, content: 'First line\nSecond line' } };
    const before = structuredClone(entry);
    assert.deepEqual(sourceFromEntry(entry), {
      id: 'message-1', role, text: 'First line\nSecond line', lines: ['First line', 'Second line'],
    });
    assert.deepEqual(entry, before);
  }
});

test('only visible text blocks are included; reasoning stays out of feedback', () => {
  const source = sourceFromEntry({ id: 'message-2', type: 'message', message: {
    role: 'assistant', content: [
      { type: 'thinking', thinking: 'Not selected' },
      { type: 'text', text: 'One' }, { type: 'text', text: 'Two' },
    ],
  } });
  assert.equal(source.text, 'One\n\nTwo');
  assert.doesNotMatch(feedback(source, [{ start: 0, end: 2, comment: 'Clarify this.' }]), /Not selected/);
});

test('image messages, tool results, empty text and non-message entries are rejected', () => {
  for (const entry of [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Caption' }, { type: 'image', data: 'placeholder' }] } },
    { type: 'message', message: { role: 'toolResult', content: 'Tool text' } },
    { type: 'message', message: { role: 'user', content: '  ' } },
    { type: 'custom', data: { text: 'Not a conversation message' } },
    undefined,
  ]) assert.equal(sourceFromEntry(entry), null);
});

test('backward and out-of-bounds selections stay within the chosen message', () => {
  assert.deepEqual(selectRange(2, 0, 3), { start: 0, end: 2 });
  assert.deepEqual(selectRange(-3, 99, 3), { start: 0, end: 2 });
});

test('Ready prepares only selected excerpts and comments and preserves an existing editor draft', () => {
  const source = { lines: ['Unselected', 'Selected one', 'Selected two', 'Unselected tail'] };
  const prepared = feedback(source, [{ start: 1, end: 2, comment: 'Explain these lines.' }]);
  assert.match(prepared, /> Selected one\n> Selected two/);
  assert.match(prepared, /Explain these lines\./);
  assert.doesNotMatch(prepared, /Unselected/);
  assert.equal(appendDraft('Existing draft', prepared), 'Existing draft\n\n' + prepared);
  assert.equal(appendDraft('', prepared), prepared);
  assert.throws(() => feedback(source, []), /at least one comment/);
});

test('terminal control characters are escaped in both source excerpts and comments', () => {
  const source = { lines: ['text\x1b[31m'] };
  const prepared = feedback(source, [{ start: 0, end: 0, comment: 'comment\x1b[0m' }]);
  assert.doesNotMatch(prepared, /\x1b/);
  assert.match(prepared, /\\x1b/);
  assert.equal(safeText('left\tright'), 'left    right');
});

test('wrapped display rows retain original line selection coordinates', () => {
  const rows = sourceRows({ lines: ['abcdef', 'second'] }, 6, (text, width) =>
    Array.from({ length: Math.ceil(text.length / width) }, (_, i) => text.slice(i * width, (i + 1) * width)));
  assert.deepEqual(rows.map(row => row.sourceLine), [0, 0, 1, 1]);
  assert.ok(rows.every(row => row.text.length <= 6));
});

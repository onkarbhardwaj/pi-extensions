import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTES_MARKER, NOTES_MESSAGE_TYPE, NoteChangedError, appendNote, lastSentHash, noteUpdate, notesPath, notesStatusText, parseNotesConfig, readNote, replaceNote } from '../src/notes.ts';
import { loadBusyworkConfig } from '../src/meetings.ts';

async function folder(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'busywork-notes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** What the session's context holds after a notes message was sent. */
const sent = (update: ReturnType<typeof noteUpdate>) => ({ type: 'custom_message', ...update });

test('notes live in a busywork folder unless the config names another path', () => {
  assert.equal(notesPath({}, '/agent'), '/agent/busywork/notes.md');
  assert.equal(notesPath({ path: '~/notes/today.md' }, '/agent'), join(homedir(), 'notes/today.md'));
  assert.equal(notesPath({ path: '/elsewhere/n.md' }, '/agent'), '/elsewhere/n.md');
  assert.throws(() => notesPath({ path: 'relative.md' }, '/agent'), /absolute/);
  assert.throws(() => parseNotesConfig({ path: 3 }), /non-empty string/);
});

test('busywork.json may configure notes beside meetings', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'busywork.json'), JSON.stringify({ notes: { path: '~/n.md' } }));
  assert.deepEqual((await loadBusyworkConfig(join(dir, 'busywork.json'))).notes, { path: '~/n.md' });
  assert.deepEqual((await loadBusyworkConfig(join(dir, 'missing.json'))).notes, {});
});

test('a missing note is empty and sends nothing to a model that never saw one', async t => {
  const note = await readNote(join(await folder(t), 'notes.md'));
  assert.equal(note.body, '');
  assert.equal(noteUpdate(note, undefined), undefined);
  assert.equal(notesStatusText(note), '📝 No notes');
});

test('appending creates the marked file, and the marker never reaches the model', async t => {
  const path = join(await folder(t), 'deep', 'notes.md');
  const note = await appendNote(path, 'Ship the CSP fix today.');
  assert.ok((await readFile(path, 'utf8')).startsWith(`${NOTES_MARKER}\n`));
  assert.equal(note.body, 'Ship the CSP fix today.');
  const update = noteUpdate(note, undefined)!;
  assert.equal(update.customType, NOTES_MESSAGE_TYPE);
  assert.ok(update.content.endsWith('\n\nShip the CSP fix today.'));
  assert.ok(!update.content.includes('busywork notes:'));
  assert.equal(notesStatusText(note), '📝 Notes · 1 line');
});

test('a change is sent once; an unchanged note sends nothing', async t => {
  const path = join(await folder(t), 'notes.md');
  const first = noteUpdate(await appendNote(path, 'one'), undefined)!;
  const context: any[] = [{ type: 'message' }, sent(first)];
  assert.equal(noteUpdate(await readNote(path), lastSentHash(context)), undefined);
  const second = noteUpdate(await appendNote(path, 'two'), lastSentHash(context))!;
  assert.ok(second.content.endsWith('one\n\ntwo'));
  assert.equal(notesStatusText(await readNote(path)), '📝 Notes · 2 lines');
  context.push(sent(second));
  assert.equal(noteUpdate(await readNote(path), lastSentHash(context)), undefined);
});

test('after compaction drops the message from context, the note is sent again', async t => {
  const note = await appendNote(join(await folder(t), 'notes.md'), 'keep this');
  const compacted = [{ type: 'compaction' }, { type: 'message' }];
  assert.ok(noteUpdate(note, lastSentHash(compacted)));
});

test('an outside edit is picked up, and clearing the note is announced', async t => {
  const path = join(await folder(t), 'notes.md');
  const context = [sent(noteUpdate(await appendNote(path, 'draft'), undefined))];
  await writeFile(path, `${NOTES_MARKER}\n\nedited in Obsidian\n`);
  assert.ok(noteUpdate(await readNote(path), lastSentHash(context))!.content.endsWith('edited in Obsidian'));
  await writeFile(path, `${NOTES_MARKER}\n`);
  assert.equal(noteUpdate(await readNote(path), lastSentHash(context))!.content, 'Shared notes were cleared.');
});

test('two concurrent appends both survive', async t => {
  const path = join(await folder(t), 'notes.md');
  await appendNote(path, 'start');
  await Promise.all([appendNote(path, 'from jeeves'), appendNote(path, 'from tao')]);
  const body = (await readNote(path)).body;
  assert.ok(body.includes('from jeeves') && body.includes('from tao') && body.startsWith('start'));
});

test('a stale replace is refused and leaves the file unchanged', async t => {
  const path = join(await folder(t), 'notes.md');
  const read = await appendNote(path, 'v1');
  await appendNote(path, 'added by another agent');
  const before = await readFile(path, 'utf8');
  await assert.rejects(replaceNote(path, 'v2', read.hash), (error: unknown) => error instanceof NoteChangedError && error.current.body.includes('another agent'));
  assert.equal(await readFile(path, 'utf8'), before);
  const fresh = await readNote(path);
  const replaced = await replaceNote(path, `${NOTES_MARKER}\nv2`, fresh.hash);
  assert.equal(replaced.body, 'v2');
  assert.equal(await readFile(path, 'utf8'), `${NOTES_MARKER}\n\nv2\n`);
});

test('notes cannot grow past the size limit', async t => {
  const path = join(await folder(t), 'notes.md');
  await assert.rejects(appendNote(path, 'x'.repeat(20_001)), /exceed/);
  assert.equal((await readNote(path)).exists, false);
});

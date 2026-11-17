import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEntry, emptyQueue, parseRef, readQueue, removeEntry, updateEntry, updateQueue } from '../src/queue.ts';

test('references parse from URLs and short forms, with GitHub Enterprise hosts kept', () => {
  assert.equal(parseRef('https://github.com/Acme/Widgets/pull/12/files').id, 'acme/widgets#12');
  assert.equal(parseRef('acme/widgets#12').url, 'https://github.com/acme/widgets/pull/12');
  const ghe = parseRef('github.example.com/team/gadgets#7');
  assert.equal(ghe.id, 'github.example.com/team/gadgets#7');
  assert.equal(parseRef('https://github.example.com/team/gadgets/pull/7').repoId, 'github.example.com/team/gadgets');
  for (const bad of ['widgets#1', 'acme/widgets#0', 'https://github.com/acme/widgets/issues/3', 'acme/wid gets#1'])
    assert.throws(() => parseRef(bad));
});

test('adding a queued PR updates it instead of duplicating, and keeps who added it', () => {
  const ref = parseRef('acme/widgets#12');
  let { queue, added } = addEntry(emptyQueue(), ref, { addedBy: 'assistant', note: 'first' }, '2026-01-01T00:00:00Z');
  assert.equal(added, true);
  assert.equal(queue.entries[0].section, 'review');
  ({ queue, added } = addEntry(queue, ref, { section: 'waiting', priority: 'high' }, '2026-01-02T00:00:00Z'));
  assert.equal(added, false);
  assert.equal(queue.entries.length, 1);
  assert.deepEqual({ ...queue.entries[0] }, {
    id: 'acme/widgets#12', repo: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12',
    section: 'waiting', priority: 'high', note: 'first', addedBy: 'assistant', addedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  });
});

test('updates can clear the note and priority; unknown PRs and bad values are rejected', () => {
  const ref = parseRef('acme/widgets#12');
  const { queue } = addEntry(emptyQueue(), ref, { note: 'x', priority: 'low' });
  const { entry } = updateEntry(queue, ref, { note: '', priority: null });
  assert.equal(entry.note, undefined);
  assert.equal(entry.priority, undefined);
  assert.throws(() => updateEntry(queue, parseRef('acme/widgets#13'), {}));
  assert.throws(() => addEntry(queue, ref, { priority: 'urgent' as any }));
  assert.throws(() => removeEntry(queue, 'acme/widgets#13'));
  assert.equal(removeEntry(queue, ref.id).entries.length, 0);
});

test('concurrent changes to the shared file all survive', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'pr-queue-')), 'queue.json');
  await Promise.all([1, 2, 3, 4, 5].map(n => updateQueue(file, queue => ({ queue: addEntry(queue, parseRef(`acme/widgets#${n}`), {}).queue, result: n }))));
  assert.deepEqual((await readQueue(file)).entries.map(e => e.number).sort(), [1, 2, 3, 4, 5]);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
});

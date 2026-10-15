import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEETINGS, parseMeetings, parseMeetingsConfig, pruneDismissed, syncMeetings } from '../src/meetings.ts';

const now = new Date('2026-10-15T10:00:00').getTime();
const at = (time: string) => new Date(`2026-10-15T${time}`).toISOString();
const meeting = (overrides = {}) => ({ id: `m1@${at('11:00:00')}`, title: 'Stand Up', start: at('11:00:00'), end: at('11:30:00'), status: 'accepted', canceled: false, ...overrides });
let counter = 0;
const newId = () => `r${++counter}`;
const sync = (reminders: any[], meetings: any[], dismissed: string[] = [], config = DEFAULT_MEETINGS) =>
  syncMeetings(reminders, meetings as any, dismissed, config, newId, now);

test('config can disable sync and rejects unsafe values', () => {
  assert.deepEqual(parseMeetingsConfig(undefined), DEFAULT_MEETINGS);
  assert.equal(parseMeetingsConfig({ enabled: false }).enabled, false);
  assert.deepEqual(parseMeetingsConfig({ statuses: ['accepted'], leadMinutes: 10 }).statuses, ['accepted']);
  for (const bad of [{ enabled: 'no' }, { statuses: ['maybe'] }, { intervalMinutes: 1 }, { leadMinutes: -1 }, { command: '' }, []]) {
    assert.throws(() => parseMeetingsConfig(bad));
  }
});

test('eligible upcoming meetings become reminders before they start', () => {
  const result = sync([], [meeting(), meeting({ id: 'm2', status: 'declined' }), meeting({ id: 'm3', canceled: true }),
    meeting({ id: 'm4', start: at('09:00:00') })]);
  assert.equal(result.added, 1);
  assert.equal(result.reminders[0].source, meeting().id);
  assert.equal(result.reminders[0].dueAt, Date.parse(at('10:55:00')));
  assert.match(result.reminders[0].text, /^📅 Stand Up at /);
  const pending = sync([], [meeting({ status: 'invited' }), meeting({ id: 'g', status: 'unknown' })]).reminders;
  assert.deepEqual(pending.map(r => r.text.endsWith('(no reply)')), [true, false]);
});

test('repeated syncs and dismissed meetings add nothing', () => {
  const first = sync([], [meeting()]);
  assert.equal(sync(first.reminders, [meeting()]).changed, false);
  assert.equal(sync([], [meeting()], [meeting().id]).changed, false);
});

test('snoozed reminders keep their time; cancelled or moved meetings drop scheduled reminders', () => {
  const [reminder] = sync([], [meeting()]).reminders;
  const snoozed = { ...reminder, dueAt: Date.parse(at('11:10:00')) };
  assert.equal(sync([snoozed], [meeting()]).reminders[0].dueAt, snoozed.dueAt);
  assert.deepEqual(sync([reminder], [meeting({ canceled: true })]).reminders, []);
  const moved = sync([reminder], [meeting({ id: `m1@${at('12:00:00')}`, start: at('12:00:00') })]);
  assert.deepEqual(moved.reminders.map(r => r.source), [`m1@${at('12:00:00')}`]);
  const due = { ...reminder, status: 'due' };
  assert.deepEqual(sync([due], []).reminders, [due]);
  const manual = { id: 'x', text: 'mine', dueAt: now + 1, createdAt: now, status: 'scheduled' };
  assert.deepEqual(sync([manual], []).reminders, [manual]);
});

test('helper output is validated and old dismissals are pruned', () => {
  assert.equal(parseMeetings(JSON.stringify([meeting(), { id: 1 }])).length, 1);
  assert.throws(() => parseMeetings('{}'));
  assert.deepEqual(pruneDismissed([`old@${new Date(now - 2 * 86_400_000).toISOString()}`, meeting().id], now), [meeting().id]);
});

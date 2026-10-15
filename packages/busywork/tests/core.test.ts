import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_TYPE, markDue, markMissed, parseRemind, parseWhen, restore, statusText } from '../src/core.ts';

const now = new Date('2026-10-15T10:00:00').getTime();
const reminder = (overrides = {}) => ({ id: 'r1', text: 'Check CI', createdAt: now, dueAt: now + 60_000, status: 'scheduled', ...overrides });

test('commands accept durations, clock times, and future ISO dates', () => {
  assert.deepEqual(parseRemind('30m Check CI', now), { dueAt: now + 30 * 60_000, text: 'Check CI' });
  assert.equal(parseWhen('in 2h', now), now + 2 * 60 * 60_000);
  assert.equal(new Date(parseWhen('09:30', now)).getDate(), 16);
  assert.equal(parseWhen('2026-10-15T11:00:00', now), new Date('2026-10-15T11:00:00').getTime());
  assert.throws(() => parseRemind('0m Never', now), /positive duration/);
  assert.throws(() => parseRemind('tomorrow Check', now), /Use 30m/);
});

test('startup marks reminders due while closed as missed; live timers mark them due', () => {
  const due = reminder({ dueAt: now - 1 });
  assert.equal(markMissed([due], now)[0].status, 'missed');
  assert.equal(markDue([due], now)[0].status, 'due');
  assert.equal(markDue([reminder()], now)[0].status, 'scheduled');
});

test('footer prioritizes reminders needing attention and otherwise shows next scheduled', () => {
  assert.equal(statusText([reminder({ status: 'due' })]), '⏰ 1 due');
  assert.match(statusText([reminder()]), /^⏰ 1 scheduled · next /);
  assert.equal(statusText([]), undefined);
});

test('session restore uses latest snapshot and rejects malformed state', () => {
  const entries = [
    { type: 'custom', customType: STATE_TYPE, data: { version: 1, reminders: [reminder()] } },
    { type: 'custom', customType: STATE_TYPE, data: { version: 1, reminders: [] } },
  ];
  assert.deepEqual(restore(entries), []);
  assert.throws(() => restore([{ type: 'custom', customType: STATE_TYPE, data: { version: 2, reminders: [] } }]), /Unsupported/);
  assert.throws(() => restore([{ type: 'custom', customType: STATE_TYPE, data: { version: 1, reminders: [reminder({ status: 'unknown' })] } }]), /Malformed/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { HEARTBEAT_STATE_TYPE, dueHeartbeat, expire, heartbeatStatusText, markRun, parseHeartbeat, restoreHeartbeats } from '../src/heartbeats.ts';

const now = new Date('2026-10-15T10:00:00').getTime();
const beat = (overrides = {}) => ({ id: 'h1', name: 'pr-ci', prompt: 'Check CI', intervalMs: 300_000, nextAt: now + 300_000, createdAt: now, status: 'active', runs: 0, ...overrides });

test('command accepts interval, optional expiry, name, and multi-word instruction', () => {
  assert.deepEqual(parseHeartbeat('5m until 2h pr-ci Check CI and report changes', now),
    { intervalMs: 300_000, expiresAt: now + 7_200_000, name: 'pr-ci', prompt: 'Check CI and report changes' });
  assert.throws(() => parseHeartbeat('4m pr-ci Check', now), /at least 5 minutes/);
  assert.throws(() => parseHeartbeat('15:30 pr-ci Check', now), /Usage/);
  assert.throws(() => parseHeartbeat('5m bad/name Check', now), /name/);
});

test('missed intervals coalesce into one run, and paused or expired beats do not run', () => {
  const late = beat({ nextAt: now - 3_600_000 });
  assert.equal(dueHeartbeat([late, beat({ id: 'h2', name: 'paused', status: 'paused', nextAt: now - 1 })], now)?.id, 'h1');
  const ran = markRun(late, now);
  assert.equal(ran.runs, 1);
  assert.equal(ran.nextAt, now + 300_000);
  assert.equal(expire([beat({ expiresAt: now })], now)[0].status, 'expired');
  assert.equal(dueHeartbeat(expire([beat({ nextAt: now, expiresAt: now })], now), now), undefined);
});

test('indicator summarizes active and paused heartbeats', () => {
  assert.match(heartbeatStatusText([beat()]), /^♥ 1 active · next /);
  assert.equal(heartbeatStatusText([beat({ status: 'paused' })]), '♥ 1 paused');
  assert.equal(heartbeatStatusText([]), undefined);
});

test('restore uses latest snapshot and rejects unsafe state', () => {
  const entry = (heartbeats: any[]) => ({ type: 'custom', customType: HEARTBEAT_STATE_TYPE, data: { version: 1, heartbeats } });
  assert.deepEqual(restoreHeartbeats([entry([beat()]), entry([])]), []);
  assert.throws(() => restoreHeartbeats([entry([beat(), beat({ id: 'h2' })])]), /Malformed/);
  assert.throws(() => restoreHeartbeats([entry([beat({ intervalMs: 1000 })])]), /Malformed/);
});

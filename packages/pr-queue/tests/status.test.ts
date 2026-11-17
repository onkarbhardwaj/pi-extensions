import test from 'node:test';
import assert from 'node:assert/strict';
import { isDone, notableChange, parseConfig, toStatus } from '../src/github.ts';
import { addEntry, emptyQueue, parseRef } from '../src/queue.ts';
import { age, cap, chipLabel, detailParts, group, statusParts } from '../src/view.ts';

const pr = (overrides = {}) => ({ title: 'Add usage analytics', author: { login: 'octocat' }, state: 'OPEN', isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', createdAt: '2026-01-01T00:00:00Z',
  statusCheckRollup: [{ name: 'ci: tests', conclusion: 'SUCCESS' }], ...overrides });

test('review state reads merged, draft, change requests, conflicts and approval', () => {
  assert.equal(toStatus(pr()).review, 'required');
  assert.equal(toStatus(pr({ state: 'MERGED' })).review, 'merged');
  assert.equal(toStatus(pr({ isDraft: true })).review, 'draft');
  assert.equal(toStatus(pr({ reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' })).review, 'changes');
  assert.equal(toStatus(pr({ mergeable: 'CONFLICTING' })).review, 'conflict');
  assert.equal(toStatus(pr({ reviewDecision: 'APPROVED' })).review, 'approved');
  assert.equal(isDone(toStatus(pr({ reviewDecision: 'APPROVED' }))), true);
  assert.equal(isDone(toStatus(pr())), false);
});

test('ignored checks do not turn CI red, and failing checks are named', () => {
  const checks = [{ name: 'ci: legacy-lint', conclusion: 'FAILURE' }, { name: 'ci: tests', conclusion: 'FAILURE' }, { name: 'advisory-bot', state: 'FAILURE' }];
  const status = toStatus(pr({ statusCheckRollup: checks }), ['legacy-lint', 'advisory-bot']);
  assert.equal(status.ci, 'failed');
  assert.deepEqual(status.failedChecks, ['ci: tests']);
  assert.equal(toStatus(pr({ statusCheckRollup: [{ name: 'x', status: 'IN_PROGRESS' }] })).ci, 'running');
  assert.equal(toStatus(pr({ statusCheckRollup: [] })).ci, undefined);
});

test('notifications fire on transitions only', () => {
  const before = toStatus(pr()), failed = toStatus(pr({ statusCheckRollup: [{ name: 'a', conclusion: 'FAILURE' }] }));
  assert.deepEqual(notableChange('widgets #1', before, failed), ['widgets #1: CI failed']);
  assert.deepEqual(notableChange('widgets #1', failed, failed), []);
  assert.deepEqual(notableChange('widgets #1', undefined, failed), []);
  assert.deepEqual(notableChange('widgets #1', before, toStatus(pr({ mergeable: 'CONFLICTING' }))), ['widgets #1: Conflict']);
  assert.deepEqual(notableChange('widgets #1', before, toStatus(pr({ state: 'MERGED' }))), ['widgets #1: merged']);
});

test('the chip counts open PRs to review and waiting; done PRs leave their sections', () => {
  let queue = emptyQueue();
  for (const [ref, section, priority] of [['acme/widgets#1', 'review', 'low'], ['acme/widgets#2', 'review', 'high'], ['acme/widgets#3', 'waiting', undefined], ['acme/widgets#4', 'review', undefined]] as const)
    queue = addEntry(queue, parseRef(ref), { section, ...(priority ? { priority } : {}) }).queue;
  const statuses = new Map([['acme/widgets#4', { status: toStatus(pr({ state: 'MERGED' })), checkedAt: 0 }]]);
  assert.equal(chipLabel(queue.entries, statuses), 'PRs 👀 2 · ⏳ 1');
  const grouped = group(queue.entries, statuses);
  assert.deepEqual(grouped.review.map(e => e.number), [2, 1]);
  assert.deepEqual(grouped.done.map(e => e.number), [4]);
});

test('rows read as title, CI and review; details carry author, adder, age and priority', () => {
  const status = toStatus(pr({ title: 'A very long pull request title that keeps going past the limit' }));
  const parts = statusParts({ status, checkedAt: 0 });
  assert.equal(parts[0].length, 45);
  assert.ok(parts[0].endsWith('…'));
  assert.deepEqual(parts.slice(1), ['✅ CI', 'Review required']);
  assert.deepEqual(statusParts(undefined), ['Checking…']);
  assert.deepEqual(statusParts({ error: 'not found', checkedAt: 0 }), ['⚠ not found']);
  const { entry } = addEntry(emptyQueue(), parseRef('acme/widgets#1'), { addedBy: 'assistant', priority: 'high' }, '2026-01-02T12:00:00');
  assert.deepEqual(detailParts(entry, { status, checkedAt: 0 }, Date.parse('2026-01-03T00:00:00Z')),
    ['octocat', 'added by assistant 01-02', 'Open since: 2d', 'Priority: High']);
  assert.equal(age('2026-01-01T00:00:00Z', Date.parse('2026-01-01T05:30:00Z')), '5h');
  assert.equal(cap('short'), 'short');
});

test('config validates CI ignore lists keyed by owner/repo', () => {
  assert.deepEqual(parseConfig(undefined), { ci: {} });
  assert.deepEqual(parseConfig({ ci: { 'Acme/Widgets': { ignore: ['a'] } } }), { ci: { 'acme/widgets': { ignore: ['a'] } } });
  assert.throws(() => parseConfig({ ci: { widgets: { ignore: [] } } }));
  assert.throws(() => parseConfig({ ci: { 'acme/widgets': { ignore: 'a' } } }));
});

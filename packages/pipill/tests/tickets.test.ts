import test from 'node:test';
import assert from 'node:assert/strict';
import { icons, matchPrs, notableChanges, summarize } from '../src/tickets.ts';

const pr = (overrides = {}) => ({ number: 1, title: 'Unrelated', url: 'u', headRefName: 'dev/marg-2425-quicksort', state: 'OPEN', isDraft: false,
  reviewDecision: '', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'ci/server: pytest-tests', conclusion: 'SUCCESS' }], ...overrides });

test('PRs match by ticket in title or branch, not numeric neighbours', () => {
  const raw = [pr(), pr({ number: 2, headRefName: 'x', title: 'MARG-2425: quicksort' }), pr({ number: 3, headRefName: 'marg-24250', title: 'MARG-24250' })];
  assert.deepEqual(matchPrs('MARG-2425', raw).map(p => p.number), [2, 1]);
});

test('ignored checks do not turn CI red, and failing jobs keep their links', () => {
  const checks = [{ name: 'ci/server: legacy-lint', conclusion: 'FAILURE', detailsUrl: 'b' },
    { name: 'ci/server: pytest-tests', conclusion: 'FAILURE', detailsUrl: 'p' }, { name: 'advisory-bot', state: 'FAILURE' }];
  const [matched] = matchPrs('MARG-2425', [pr({ statusCheckRollup: checks })], ['legacy-lint', 'advisory-bot']);
  assert.equal(matched.ci, 'failed');
  assert.deepEqual(matched.failedChecks, [{ name: 'ci/server: pytest-tests', url: 'p' }]);
  assert.equal(matchPrs('MARG-2425', [pr({ statusCheckRollup: checks.slice(0, 1) })], ['legacy-lint'])[0].ci, undefined);
});

test('pill icons pick the most urgent CI and review state; merged replaces both', () => {
  const prs = matchPrs('MARG-2425', [
    pr({ number: 1, reviewDecision: 'APPROVED' }),
    pr({ number: 2, mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'a', status: 'IN_PROGRESS' }] }),
  ]);
  assert.deepEqual(icons(summarize(prs)), ['⏳', '❗']);
  assert.deepEqual(icons(summarize(matchPrs('MARG-2425', [pr({ state: 'MERGED' })]))), ['🔀']);
  assert.deepEqual(icons(summarize([])), []);
});

test('notifications fire only for new failures, review attention, and merges', () => {
  const before = summarize(matchPrs('MARG-2425', [pr()]));
  const after = summarize(matchPrs('MARG-2425', [pr({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ name: 'a', conclusion: 'FAILURE' }] })]));
  assert.deepEqual(notableChanges('MARG-2425', before, after), ['MARG-2425 #1: CI failed', 'MARG-2425 #1: Changes requested']);
  assert.deepEqual(notableChanges('MARG-2425', after, after), []);
  assert.deepEqual(notableChanges('MARG-2425', undefined, after), []);
});

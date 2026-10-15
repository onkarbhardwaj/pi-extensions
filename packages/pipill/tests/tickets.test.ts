import test from 'node:test';
import assert from 'node:assert/strict';
import { icons, matchPrs, notableChanges, summarize } from '../src/tickets.ts';

const pr = (overrides = {}) => ({ number: 1, title: 'Unrelated', url: 'u', headRefName: 'dev/dcai-2425-fonts', state: 'OPEN', isDraft: false,
  reviewDecision: '', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'ci/circleci_enterprise: pytest-tests', conclusion: 'SUCCESS' }], ...overrides });

test('PRs match by ticket in title or branch, not numeric neighbours', () => {
  const raw = [pr(), pr({ number: 2, headRefName: 'x', title: 'DCAI-2425: fonts' }), pr({ number: 3, headRefName: 'dcai-24250', title: 'DCAI-24250' })];
  assert.deepEqual(matchPrs('DCAI-2425', raw).map(p => p.number), [2, 1]);
});

test('ignored checks do not turn CI red, and failing jobs keep their links', () => {
  const checks = [{ name: 'ci/circleci_enterprise: backend-banned-deps', conclusion: 'FAILURE', detailsUrl: 'b' },
    { name: 'ci/circleci_enterprise: pytest-tests', conclusion: 'FAILURE', detailsUrl: 'p' }, { name: 'Kodiak', state: 'FAILURE' }];
  const [matched] = matchPrs('DCAI-2425', [pr({ statusCheckRollup: checks })], ['backend-banned-deps', 'Kodiak']);
  assert.equal(matched.ci, 'failed');
  assert.deepEqual(matched.failedChecks, [{ name: 'ci/circleci_enterprise: pytest-tests', url: 'p' }]);
  assert.equal(matchPrs('DCAI-2425', [pr({ statusCheckRollup: checks.slice(0, 1) })], ['backend-banned-deps'])[0].ci, undefined);
});

test('pill icons pick the most urgent CI and review state; merged replaces both', () => {
  const prs = matchPrs('DCAI-2425', [
    pr({ number: 1, reviewDecision: 'APPROVED' }),
    pr({ number: 2, mergeable: 'CONFLICTING', statusCheckRollup: [{ name: 'a', status: 'IN_PROGRESS' }] }),
  ]);
  assert.deepEqual(icons(summarize(prs)), ['⏳', '❗']);
  assert.deepEqual(icons(summarize(matchPrs('DCAI-2425', [pr({ state: 'MERGED' })]))), ['🔀']);
  assert.deepEqual(icons(summarize([])), []);
});

test('notifications fire only for new failures, review attention, and merges', () => {
  const before = summarize(matchPrs('DCAI-2425', [pr()]));
  const after = summarize(matchPrs('DCAI-2425', [pr({ reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ name: 'a', conclusion: 'FAILURE' }] })]));
  assert.deepEqual(notableChanges('DCAI-2425', before, after), ['DCAI-2425 #1: CI failed', 'DCAI-2425 #1: Changes requested']);
  assert.deepEqual(notableChanges('DCAI-2425', after, after), []);
  assert.deepEqual(notableChanges('DCAI-2425', undefined, after), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeMarkdown, pillMarkdown } from '../src/panel-markdown.ts';
import { matchPrs, summarize } from '../src/tickets.ts';

const pr = (overrides = {}) => ({ number: 7, title: 'MARG-1 fix', url: 'https://example.test/pull/7', headRefName: 'marg-1', state: 'OPEN',
  isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'ci: unit', conclusion: 'FAILURE', detailsUrl: 'https://ci.test/1' }], ...overrides });

test('labels and fetched text are escaped; titles and descriptions keep their Markdown', () => {
  assert.equal(escapeMarkdown('a_b*c [x]'), 'a\\_b\\*c \\[x\\]');
  const text = pillMarkdown({ label: 'topic_one', title: 'A **bold** title', description: 'Use `npm test`' });
  assert.deepEqual(text.split('\n\n'), ['## topic\\_one', 'A **bold** title', 'Use `npm test`']);
});

test('ticket pills show bar icons in the heading, PRs as a list, and failing checks nested', () => {
  const status = summarize(matchPrs('MARG-1', [pr()]));
  const text = pillMarkdown({ label: 'MARG-1 fix' }, 'MARG-1', status);
  assert.match(text, /^## MARG-1 fix ❌$/m);
  assert.match(text, /^- #7 Open · CI failed · https:\/\/example\.test\/pull\/7$/m);
  assert.match(text, /^ {2}- ✗ `ci: unit` · https:\/\/ci\.test\/1$/m);
});

test('ticket pills explain missing, pending, and failed lookups', () => {
  assert.match(pillMarkdown({ label: 'MARG-1' }, 'MARG-1'), /_Checking PRs…_/);
  assert.match(pillMarkdown({ label: 'MARG-1' }, 'MARG-1', summarize([])), /_No PR matched\._/);
  assert.match(pillMarkdown({ label: 'MARG-1' }, 'MARG-1', { prs: [], error: 'gh: offline', checkedAt: 0 }), /_PR check failed: gh: offline_/);
});

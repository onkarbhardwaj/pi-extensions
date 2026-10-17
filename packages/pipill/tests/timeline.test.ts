import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMELINE, parseConfig } from '../src/config.ts';
import { TIMELINE_STATE_TYPE, adoptTopic, applyUpdates, backoffMs, buildInput, dismissTopic, newMessages, parseOutput, restoreTimeline, runSummarizer, suggestions } from '../src/timeline.ts';

const empty = () => ({ timelines: {}, recent: [], dismissed: [] });
const ticketOf = (label: string) => label.match(/^[A-Z]+-\d+/)?.[0];

const msg = (id: string, role: string, content: any) => ({ type: 'message', id, message: { role, content } });

test('timeline config is off by default and validated', () => {
  assert.deepEqual(parseConfig({}).timeline, DEFAULT_TIMELINE);
  assert.equal(DEFAULT_TIMELINE.enabled, false);
  assert.deepEqual(parseConfig({ timeline: { enabled: true, provider: 'openai', model: 'gpt-6-luna', timeoutSeconds: 20 } }).timeline,
    { ...DEFAULT_TIMELINE, enabled: true, provider: 'openai', model: 'gpt-6-luna' });
  for (const bad of [{ enabled: 'yes' }, { model: 'a b' }, { timeoutSeconds: 1 }, { minMessages: 1.5 }, []])
    assert.throws(() => parseConfig({ timeline: bad }));
});

test('only user and assistant text after the cursor counts as new', () => {
  const branch = [msg('a', 'user', 'old'), msg('b', 'assistant', [{ type: 'text', text: 'old reply' }]),
    msg('c', 'user', 'new question'), msg('d', 'toolResult', 'tool output'), { type: 'custom', id: 'e' },
    msg('f', 'assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'new answer' }])];
  const batch = newMessages(branch, 'b');
  assert.deepEqual(batch.messages, [{ role: 'user', text: 'new question' }, { role: 'assistant', text: 'new answer' }]);
  assert.deepEqual([batch.count, batch.lastId], [2, 'f']);
  assert.equal(newMessages(branch, 'missing').count, 4, 'an unknown cursor treats the branch as new');
});

test('long conversations keep the newest text within the size limit', () => {
  const branch = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, 'user', `${i} ` + 'x'.repeat(1990)));
  const { messages, count } = newMessages(branch);
  assert.equal(count, 60);
  assert.ok(messages.length < 60 && messages.at(-1)!.text.startsWith('59 '));
});

test('summarizer output is validated; unknown labels, non-strings and bad recent entries are dropped', () => {
  const out = 'noise {"updates": {"alpha": "Merged PR 10.\\nNext: docs.", "beta": null, "ghost": "x", "gamma": 3},'
    + ' "recent": [{"text": "Merged PR 10.", "topic": "alpha"}, {"text": "Chatted.", "topic": null}, {"topic": "x"}, {"text": "  ", "topic": "y"}]} trailing';
  assert.deepEqual(parseOutput(out, ['alpha', 'beta', 'gamma']), {
    updates: { alpha: 'Merged PR 10. Next: docs.' },
    recent: [{ text: 'Merged PR 10.', topic: 'alpha' }, { text: 'Chatted.', topic: null }] });
  assert.deepEqual(parseOutput('{"updates": {}}', ['alpha']), { updates: {}, recent: [] });
  assert.throws(() => parseOutput('no json here', ['alpha']), /no JSON/);
  assert.throws(() => parseOutput('{"alpha": }', ['alpha']), /invalid JSON/);
});

test('updates append per label, recent keeps the newest 30, and state restores from session entries', () => {
  const recent = Array.from({ length: 35 }, (_, i) => ({ text: `step ${i}.`, topic: null }));
  const state = applyUpdates(applyUpdates(empty(), { alpha: 'one' }, [], 'c1'), { alpha: 'two', beta: 'b' }, recent, 'c2');
  assert.deepEqual([state.cursor, state.timelines], ['c2', { alpha: ['one', 'two'], beta: ['b'] }]);
  assert.deepEqual([state.recent.length, state.recent[0].text], [30, 'step 5.']);
  const entries = [{ type: 'custom', customType: TIMELINE_STATE_TYPE, data: { version: 1, ...state } }];
  assert.deepEqual(restoreTimeline(entries), state);
  assert.deepEqual(restoreTimeline([{ type: 'custom', customType: TIMELINE_STATE_TYPE, data: { version: 1, timelines: {} } }]), empty());
  const input = JSON.parse(buildInput([{ label: 'alpha' }], state, [{ role: 'user', text: 'hi' }]));
  assert.deepEqual(input.pills[0].earlierUpdates, ['one', 'two']);
});

test('suggestions are recent topic tags without pills, duplicates, or dismissed labels, newest first, at most three', () => {
  const tag = (topic: string | null) => ({ text: 'x.', topic });
  const state = { ...empty(), recent: [tag('Old idea'), tag('MARG-1 quicksort'), tag(null), tag('on-call rotation'), tag('Self review'),
    tag('On-call rotation'), tag('alpha'), tag('MARG-1 quicksort slowdown'), tag('Venue search')], dismissed: ['self review'] };
  assert.deepEqual(suggestions(state, ['alpha'], ticketOf), ['Venue search', 'MARG-1 quicksort slowdown', 'On-call rotation']);
  assert.deepEqual(suggestions(state, ['alpha', 'MARG-1 anything'], ticketOf), ['Venue search', 'On-call rotation', 'Old idea']);
  assert.deepEqual(suggestions(dismissTopic(state, 'Venue search'), ['alpha'], ticketOf).slice(0, 1), ['MARG-1 quicksort slowdown']);
});

test('adopting a topic starts its timeline from tagged recent entries, oldest first', () => {
  const state = { ...empty(), recent: [{ text: 'Found the slow step.', topic: 'MARG-1 quicksort' }, { text: 'Chatted.', topic: null },
    { text: 'Switched to median-of-three pivots. Sort now 0.4s.', topic: 'MARG-1 quicksort slowdown' }, { text: 'Other.', topic: 'beta' }] };
  assert.deepEqual(adoptTopic(state, 'MARG-1 quicksort slowdown', ticketOf).timelines,
    { 'MARG-1 quicksort slowdown': ['Found the slow step.', 'Switched to median-of-three pivots. Sort now 0.4s.'] });
  assert.deepEqual(adoptTopic(state, 'BETA', ticketOf).timelines, { BETA: ['Other.'] });
});

test('retries back off up to 30 minutes', () => {
  assert.deepEqual([0, 1, 3, 10].map(backoffMs), [0, 120_000, 480_000, 1_800_000]);
});

test('the summarizer process is stopped at the time limit and failures reject', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-pi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'pi');
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = `${dir}:${path}`;
  await writeFile(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"updates": {"alpha": "done"}}\'\n'); await chmod(fake, 0o755);
  assert.match(await runSummarizer('input', { ...DEFAULT_TIMELINE, timeoutSeconds: 5 }), /"alpha": "done"/);
  await writeFile(fake, '#!/bin/sh\nexec sleep 30\n');
  const started = Date.now();
  await assert.rejects(runSummarizer('input', { ...DEFAULT_TIMELINE, timeoutSeconds: 5 }), /timed out after 5 s/);
  assert.ok(Date.now() - started < 8000);
  await writeFile(fake, '#!/bin/sh\necho "auth failed" >&2\nexit 2\n');
  await assert.rejects(runSummarizer('input', DEFAULT_TIMELINE), /auth failed/);
});

test('long updates keep whole sentences within 120 characters and never cut mid-word', async () => {
  const { shorten } = await import('../src/timeline.ts');
  const first = 'Regenerated the GitHub token as fine-grained.', second = 'Contents still allows writes.';
  const long = `${first} ${second} ${'Extra detail follows here. '.repeat(8)}`;
  const kept = shorten(long);
  assert.ok(kept.length <= 120 && kept.startsWith(`${first} ${second}`) && kept.endsWith('.'));
  assert.ok(long.startsWith(kept), 'only whole leading sentences are kept');
  const run = 'word '.repeat(60).trim();
  const cut = shorten(run);
  assert.ok(cut.length <= 120 && cut.endsWith('word…'));
  assert.equal(shorten('Short.'), 'Short.');
});

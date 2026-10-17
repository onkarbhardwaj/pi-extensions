import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TIMELINE, parseConfig } from '../src/config.ts';
import { TIMELINE_STATE_TYPE, applyUpdates, backoffMs, buildInput, newMessages, parseUpdates, restoreTimeline, runSummarizer } from '../src/timeline.ts';

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

test('summarizer output is validated; unknown labels and non-strings are dropped', () => {
  const out = 'noise {"alpha": "Merged PR 10.\\nNext: docs.", "beta": null, "ghost": "x", "gamma": 3} trailing';
  assert.deepEqual(parseUpdates(out, ['alpha', 'beta', 'gamma']), { alpha: 'Merged PR 10. Next: docs.' });
  assert.throws(() => parseUpdates('no json here', ['alpha']), /no JSON/);
  assert.throws(() => parseUpdates('{"alpha": }', ['alpha']), /invalid JSON/);
});

test('updates append per label, move the cursor, and restore from session entries', () => {
  const state = applyUpdates(applyUpdates({ timelines: {} }, { alpha: 'one' }, 'c1'), { alpha: 'two', beta: 'b' }, 'c2');
  assert.deepEqual(state, { cursor: 'c2', timelines: { alpha: ['one', 'two'], beta: ['b'] } });
  const entries = [{ type: 'custom', customType: TIMELINE_STATE_TYPE, data: { version: 1, ...state } }];
  assert.deepEqual(restoreTimeline(entries), state);
  assert.deepEqual(restoreTimeline([{ type: 'custom', customType: TIMELINE_STATE_TYPE, data: { version: 9 } }]), { timelines: {} });
  const input = JSON.parse(buildInput([{ label: 'alpha' }], state, [{ role: 'user', text: 'hi' }]));
  assert.deepEqual(input.pills[0].earlierUpdates, ['one', 'two']);
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
  await writeFile(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"alpha": "done"}\'\n'); await chmod(fake, 0o755);
  assert.match(await runSummarizer('input', { ...DEFAULT_TIMELINE, timeoutSeconds: 5 }), /"alpha": "done"/);
  await writeFile(fake, '#!/bin/sh\nsleep 30\n');
  const started = Date.now();
  await assert.rejects(runSummarizer('input', { ...DEFAULT_TIMELINE, timeoutSeconds: 5 }), /timed out after 5 s/);
  assert.ok(Date.now() - started < 8000);
  await writeFile(fake, '#!/bin/sh\necho "auth failed" >&2\nexit 2\n');
  await assert.rejects(runSummarizer('input', DEFAULT_TIMELINE), /auth failed/);
});

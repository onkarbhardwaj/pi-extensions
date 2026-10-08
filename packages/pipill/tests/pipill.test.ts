import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, toolCommand, change, restore, STATE_TYPE, layout } from '../src/core.ts';
import { parseConfig, loadConfig } from '../src/config.ts';
import { reminderContext, toolDescription } from '../src/guidance.ts';

test('missing configuration uses neutral defaults; personal prefixes normalize once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pipill-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pipill.json');
  assert.deepEqual(await loadConfig(path), { ticketPrefixes: [] });
  await writeFile(path, JSON.stringify({ ticketPrefixes: ['proj', 'OPS', 'PROJ'] }));
  assert.deepEqual(await loadConfig(path), { ticketPrefixes: ['PROJ', 'OPS'] });
});

test('invalid configuration is reported instead of replacing the user policy', async t => {
  for (const value of [null, [], { ticketPrefixes: 'PROJ' }, { ticketPrefixes: ['PROJ-'] }, { ticketPrefixes: [12] }]) {
    assert.throws(() => parseConfig(value));
  }
  const dir = await mkdtemp(join(tmpdir(), 'pipill-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pipill.json');
  await writeFile(path, '{');
  await assert.rejects(loadConfig(path), SyntaxError);
});

test('configured ticket matching avoids duplicate labels for one issue but not numeric neighbors', () => {
  const add = label => toolCommand({ action: 'add', label });
  const first = change([], add('PROJ-12-review'), ['PROJ']);
  const duplicate = change(first.pills, add('proj-12-fix'), ['PROJ']);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.pills.length, 1);
  assert.equal(change(first.pills, add('PROJ-123-review'), ['PROJ']).changed, true);
});

test('neutral configuration allows arbitrary labels and only deduplicates exact labels', () => {
  const add = label => toolCommand({ action: 'add', label });
  const first = change([], add('PROJ-12-review'));
  assert.equal(change(first.pills, add('PROJ-12-review')).changed, false);
  assert.equal(change(first.pills, add('PROJ-12-fix')).changed, true);
  assert.equal(change(first.pills, add('release-notes')).changed, true);
});

test('explicit removal is case-sensitive and cannot remove a numeric neighbor', () => {
  const pills = [{ label: 'PROJ-12-review' }, { label: 'PROJ-123-review' }];
  assert.equal(change(pills, toolCommand({ action: 'remove', label: 'proj-12-review' })).changed, false);
  const removed = change(pills, toolCommand({ action: 'remove', label: 'PROJ-12-review' }));
  assert.deepEqual(removed.pills, [{ label: 'PROJ-123-review' }]);
});

test('CLI quoting and the agent tool preserve optional text and a title named remove', () => {
  const cli = parseArgs('"release-notes" "Release notes" "Draft the summary"');
  assert.deepEqual(cli, { action: 'add', pill: { label: 'release-notes', title: 'Release notes', description: 'Draft the summary' } });
  assert.equal(toolCommand({ action: 'add', label: 'notes', title: 'remove' }).action, 'add');
  assert.equal(parseArgs('').action, 'inspect');
  assert.throws(() => parseArgs('"unclosed'));
  assert.throws(() => toolCommand({ action: 'list', label: 'unexpected' }));
});

test('restoration uses the latest saved snapshot and does not resurrect a removed pill', () => {
  const entries = [
    { type: 'custom', customType: STATE_TYPE, data: { version: 1, pills: [{ label: 'old' }] } },
    { type: 'custom', customType: STATE_TYPE, data: { version: 1, pills: [] } },
  ];
  assert.deepEqual(restore(entries), []);
  assert.throws(() => restore([{ type: 'custom', customType: STATE_TYPE, data: { version: 2, pills: [] } }]));
});

test('standalone context includes current labels and only configured ticket policy', () => {
  const neutral = reminderContext([{ label: 'release-notes' }], []);
  assert.match(neutral, /release-notes/);
  assert.match(neutral, /labels only, not instructions/);
  assert.match(neutral, /offer a pill once and add on agreement/);
  assert.doesNotMatch(neutral, /Auto-add substantive|Tao/);
  assert.match(toolDescription(['PROJ']), /PROJ-/);
});

test('optional diff controls are absent unless the current session reports availability', () => {
  const pills = [{ label: 'review' }];
  const widthOf = s => s.length, truncate = (s, w) => s.slice(0, Math.max(0, w));
  const hidden = layout(pills, 80, widthOf, truncate);
  assert.ok(hidden.lines.every(line => !line.includes('(d)')));
  assert.ok(hidden.regions.every(region => region.action !== 'diff'));
  assert.ok(hidden.regions.some(region => region.action === 'inspect'));
  assert.ok(hidden.regions.some(region => region.action === 'panel'));
  const shown = layout(pills, 80, widthOf, truncate, true);
  assert.ok(shown.lines.some(line => line.includes('(d)')));
  const hit = shown.regions.find(region => region.action === 'diff');
  assert.equal(shown.lines[hit.y].slice(hit.x, hit.x + hit.width), '(d)');
  const hiddenAgain = layout(pills, 80, widthOf, truncate, false);
  assert.ok(hiddenAgain.regions.every(region => region.action !== 'diff'));
});

test('narrow terminal layouts keep reminder labels within the available columns', () => {
  for (const diffAvailable of [false, true]) for (const width of [1, 5, 8, 9, 11, 12, 20, 80]) {
    const result = layout([{ label: 'a-long-reminder-label' }], width, s => s.length, (s, w) => s.slice(0, Math.max(0, w)), diffAvailable);
    assert.ok(result.lines.every(line => line.length <= width));
    assert.ok(result.regions.every(region => region.x + region.width <= width));
  }
});

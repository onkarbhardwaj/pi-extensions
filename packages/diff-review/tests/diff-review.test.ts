import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, branchMatches, parseArgs, resolveTarget, snapshot, selectedExcerpt, reviewJSON, safeText } from '../src/core.ts';

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'diff-review-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  await writeFile(join(path, 'notes.txt'), 'original\n');
  git('add', '.'); git('commit', '-m', 'base');
  git('switch', '-c', 'work/PROJ-12-demo');
  return { path, git, config: { version: 1, ticketPrefixes: ['PROJ'], repositories: [{ name: 'test-project', path, defaultBase: 'main' }] } };
}

test('repository config defaults to neutral matching and normalizes personal prefixes', async t => {
  const f = await fixture(t), path = join(f.path, 'config.json');
  const { ticketPrefixes, ...neutral } = f.config;
  await writeFile(path, JSON.stringify(neutral));
  assert.deepEqual((await loadConfig(path)).ticketPrefixes, []);
  await writeFile(path, JSON.stringify({ ...f.config, ticketPrefixes: ['proj', 'PROJ'] }));
  assert.deepEqual((await loadConfig(path)).ticketPrefixes, ['PROJ']);
  await writeFile(path, JSON.stringify({ ...f.config, ticketPrefixes: ['PROJ-'] }));
  await assert.rejects(loadConfig(path), /ticketPrefixes/);
});

test('missing repository config reports failure rather than guessing a checkout', async () => {
  await assert.rejects(loadConfig(join(tmpdir(), 'missing-diff-review-config-' + crypto.randomUUID())));
});

test('neutral branch matching is literal; configured IDs match exactly and case-insensitively', () => {
  assert.equal(branchMatches('work/PROJ-123-demo', 'PROJ-12'), true);
  assert.equal(branchMatches('work/PROJ-123-demo', 'PROJ-12', ['PROJ']), false);
  assert.equal(branchMatches('work/PROJ-12-demo', 'proj-12', ['PROJ']), true);
  assert.equal(branchMatches('work/PROJ-12-demo', 'demo', ['PROJ']), true);
  assert.throws(() => branchMatches('', 'PROJ-12 OPS-3', ['PROJ', 'OPS']), /one ticket/);
});

test('review target resolves a checked-out branch without requiring a pill or persona', async t => {
  const f = await fixture(t);
  const target = await resolveTarget(f.config, 'proj-12');
  assert.equal(target.branch, 'work/PROJ-12-demo');
  assert.equal(target.path, await realpath(f.path));
  await assert.rejects(resolveTarget(f.config, 'PROJ-123'), /No checked-out branch/);
});

test('multiple matching worktrees produce an explicit ambiguity error', async t => {
  const f = await fixture(t), other = f.path + '-other';
  t.after(() => rm(other, { recursive: true, force: true }));
  f.git('worktree', 'add', '-b', 'work/PROJ-12-other', other, 'main');
  await assert.rejects(resolveTarget(f.config, 'PROJ-12'), /Multiple worktrees/);
});

test('snapshot includes committed, staged, unstaged and untracked changes without modifying them', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'notes.txt'), 'committed\n');
  f.git('add', 'notes.txt'); f.git('commit', '-m', 'branch change');
  await writeFile(join(f.path, 'staged.txt'), 'staged\n'); f.git('add', 'staged.txt');
  await writeFile(join(f.path, 'notes.txt'), 'working\n');
  await writeFile(join(f.path, 'untracked.txt'), 'new\n');
  const before = f.git('status', '--porcelain');
  const target = await resolveTarget(f.config, 'PROJ-12');
  const review = await snapshot(target, undefined);
  assert.deepEqual(review.files.map(file => file.path).sort(), ['notes.txt', 'staged.txt', 'untracked.txt']);
  const notes = review.files.find(file => file.path === 'notes.txt');
  assert.ok(notes.rows.some(row => row.kind === 'delete' && row.text === 'original'));
  assert.ok(notes.rows.some(row => row.kind === 'add' && row.text === 'working'));
  assert.equal(f.git('status', '--porcelain'), before);
});

test('selected comments export captured code and metadata, with no automatic submission', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'notes.txt'), 'changed\n');
  const review = await snapshot(await resolveTarget(f.config, 'PROJ-12'), undefined);
  const fileIndex = review.files.findIndex(file => file.path === 'notes.txt');
  const file = review.files[fileIndex], line = file.rows.findIndex(row => row.kind === 'add');
  const selection = selectedExcerpt(file, line, line);
  const output = JSON.parse(reviewJSON(review, [{ fileIndex, selection, comment: 'Check this wording.' }]));
  assert.equal(output.scope, 'merge-base-to-working-tree');
  assert.match(output.comments[0].excerpt, /\+changed/);
  assert.equal(output.comments[0].comment, 'Check this wording.');
  assert.ok(output.comments[0].newContentHashPrefix.length >= 7);
  assert.throws(() => reviewJSON(review, []), /at least one comment/);
});

test('binary files remain visible but cannot produce a code selection', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'binary.bin'), Buffer.from([0, 1, 2]));
  const review = await snapshot(await resolveTarget(f.config, 'PROJ-12'), undefined);
  const file = review.files.find(file => file.path === 'binary.bin');
  assert.equal(file.reason, 'Binary file.');
  assert.throws(() => selectedExcerpt(file, 0, 0), /Select at least one code line/);
});

test('CLI rejects option-shaped branch patterns and preserves base overrides', () => {
  assert.deepEqual(parseArgs('demo --base main'), { pattern: 'demo', base: 'main' });
  assert.throws(() => parseArgs('--help'));
  assert.throws(() => parseArgs('demo --base --unsafe'));
  assert.equal(safeText('a\x1bb'), 'a\\x1bb');
});

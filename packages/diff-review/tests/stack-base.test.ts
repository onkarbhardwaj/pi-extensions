import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, snapshot } from '../src/core.ts';
import { parentFromCatalog } from '../src/stack-base.ts';

const state = { schemaVersion: 1, stacks: [{ trunk: { branch: 'main' }, branches: [{ branch: 'lower' }, { branch: 'upper' }] }] };
test('catalog distinguishes immediate parent and trunk and rejects ambiguity/schema drift', () => {
  assert.deepEqual(parentFromCatalog(state, 'upper'), { base: 'lower', baseSource: 'stack-parent' });
  assert.deepEqual(parentFromCatalog(state, 'lower'), { base: 'main', baseSource: 'stack-trunk' });
  assert.equal(parentFromCatalog(state, 'unstacked'), undefined);
  assert.throws(() => parentFromCatalog({ ...state, schemaVersion: 2 }, 'upper'), /Unsupported/);
  assert.throws(() => parentFromCatalog({ ...state, stacks: [...state.stacks, ...state.stacks] }, 'upper'), /multiple/);
});
test('real worktree snapshot excludes lower layer, includes local edits, never modifies catalog', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pi-stack-test-'))); const repo = join(dir, 'repo'); await mkdir(repo);
  try {
    await git(repo, ['init', '-b', 'main']); await git(repo, ['config', 'user.name', 'Fixture']); await git(repo, ['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'base.txt'), 'base\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'base']);
    await git(repo, ['checkout', '-b', 'lower']); await writeFile(join(repo, 'lower.txt'), 'lower\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'lower']);
    await git(repo, ['checkout', '-b', 'upper']); await writeFile(join(repo, 'upper.txt'), 'upper committed\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-m', 'upper']);
    const wt = join(dir, 'linked'); await git(repo, ['worktree', 'add', wt, 'lower']);
    await writeFile(join(wt, 'lower.txt'), 'uncommitted lower should not enter review\n');
    await writeFile(join(repo, 'upper.txt'), 'upper working\n');
    const catalog = join(repo, '.git', 'gh-stack'); const original = JSON.stringify(state); await writeFile(catalog, original);
    const target = { path: repo, branch: 'upper', repository: { name: 'fixture', defaultBase: 'main' } };
    const review = await snapshot(target);
    assert.equal(review.base, 'lower'); assert.equal(review.baseSource, 'stack-parent');
    assert.deepEqual(review.files.map(f => f.path), ['upper.txt']);
    assert.ok(review.files[0].rows.some(r => r.text === 'upper working'));
    assert.equal(await readFile(catalog, 'utf8'), original);
    const explicit = await snapshot(target, 'main'); assert.equal(explicit.baseSource, 'explicit'); assert.ok(explicit.files.some(f => f.path === 'lower.txt'));
    // Parent advances after upper was created: merge base still isolates the upper layer.
    await writeFile(join(wt, 'lower.txt'), 'advanced lower\n'); await git(wt, ['add', '.']); await git(wt, ['commit', '-m', 'advance lower']);
    const behind = await snapshot(target); assert.deepEqual(behind.files.map(f => f.path), ['upper.txt']);
    const bottom = await snapshot({ ...target, path: wt, branch: 'lower' }); assert.equal(bottom.baseSource, 'stack-trunk');
    await writeFile(catalog, '{broken'); await assert.rejects(snapshot(target), /Cannot read gh-stack/);
    assert.equal((await snapshot(target, 'main')).baseSource, 'explicit');
    await writeFile(catalog, original); await git(repo, ['branch', '-D', 'main']);
    await assert.rejects(snapshot({ ...target, path: wt, branch: 'lower' }), /missing locally/);
    await rm(catalog); const fallback = await snapshot({ ...target, repository: { name: 'fixture', defaultBase: 'lower' } });
    assert.equal(fallback.baseSource, 'configured-default');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

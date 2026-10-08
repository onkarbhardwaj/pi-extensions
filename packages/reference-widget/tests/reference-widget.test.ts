import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_TYPE, MAX_BYTES, resolvePath, commandPath, addPath, readSnapshot, restore, labels, excerpt, feedback, safeText } from '../src/core.ts';
import { diagramMarkdown } from '../src/mermaid.ts';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'pi-reference-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return realpath(path);
}

test('full and relative paths with spaces resolve to the same reference, including symlinks', async t => {
  const root = await directory(t), path = join(root, 'two words.md');
  await writeFile(path, '# Heading\n'); await symlink(path, join(root, 'alias.md'));
  assert.equal(await addPath(commandPath('"two words.md"')!, root), path);
  assert.equal(await addPath(path, root), path);
  assert.equal(await addPath('alias.md', root), path);
  assert.equal(commandPath('two words.md'), 'two words.md');
  assert.equal(commandPath(''), undefined);
  assert.throws(() => commandPath('"unfinished'), /quote/);
  assert.throws(() => resolvePath('bad\0.md', root), /control/);
});

test('file contents are bounded and decoded strictly; unavailable files remain readable errors', async t => {
  const root = await directory(t), path = join(root, 'reference.md');
  await writeFile(path, '# Hello\n世界\n');
  const snap = await readSnapshot(path);
  assert.equal(snap.text, '# Hello\n世界\n');assert.equal(snap.hash?.length, 64);
  await writeFile(path, Buffer.from([0xff,0xfe]));assert.ok((await readSnapshot(path)).error);
  await writeFile(path, 'x'.repeat(MAX_BYTES + 1));await assert.rejects(addPath(path, root), /limit/);
  assert.ok((await readSnapshot(path)).error);
  await unlink(path);assert.ok((await readSnapshot(path)).error);
  await writeFile(join(root,'not.txt'),'text');await assert.rejects(addPath('not.txt',root), /Markdown/);
  await assert.rejects(addPath(root,root));
});

test('latest session snapshot restores removals without modifying files or older state', () => {
  const entries=[{type:'custom',customType:STATE_TYPE,data:{version:1,paths:['/a.md','/b.md']}},
    {type:'custom',customType:STATE_TYPE,data:{version:1,paths:['/b.md']}}];
  const value=restore(entries);assert.deepEqual(value,['/b.md']);value.push('/c.md');assert.deepEqual(restore(entries),['/b.md']);
  assert.deepEqual(restore([]),[]);
  assert.throws(()=>restore([{type:'custom',customType:STATE_TYPE,data:{version:1,paths:['relative.md']}}]),/Invalid/);
});

test('duplicate basenames get readable distinct labels without showing full paths', () => {
  assert.deepEqual(labels(['/a/notes.md','/b/notes.md','/c/other.md']),['notes.md (1)','notes.md (2)','other.md']);
});

test('comments capture displayed text without ANSI and survive later layout changes', () => {
  const lines=['\x1b[1mHeading\x1b[0m','A rendered line','┌────┐','│ A  │','└────┘'];
  const selected=excerpt(lines,3,1);assert.equal(selected,'A rendered line\n┌────┐\n│ A  │');
  const note={path:'/notes.md',name:'notes.md',hash:'hash',excerpt:excerpt(lines,0,1),comment:'Clarify this.'};
  lines.splice(0,lines.length,'Entirely different wrapping');
  const result=feedback([note]);assert.match(result,/> Heading\n> A rendered line/);assert.doesNotMatch(result,/\x1b|Entirely different/);
  assert.match(result,/rendered text, not source line coordinates/);
  assert.throws(()=>excerpt([],undefined,0),/Select/);assert.throws(()=>feedback([]),/comment/);
  assert.equal(safeText('\x1b[31m'), '\\x1b[31m');
});

test('multiple files retain separate excerpts and comments in one prepared draft', () => {
  const result=feedback([{path:'/a.md',name:'a.md',hash:'a',excerpt:'First',comment:'One'},
    {path:'/b.md',name:'b.md',hash:'b',excerpt:'Second',comment:'Two'}]);
  assert.match(result,/File: a.md/);assert.match(result,/File: b.md/);assert.match(result,/> First/);assert.match(result,/> Second/);
});

test('Mermaid uses grok box drawings when they fit; unsupported or wide blocks stay source', () => {
  const source='graph LR\n A[Alpha] --> B[Beta]',raw='```mermaid\n'+source+'\n```\n';
  const rendered=diagramMarkdown(source,raw,100);
  assert.notEqual(rendered,raw);assert.match(rendered,/Alpha/);assert.match(rendered,/[─│┌]/);
  assert.equal(diagramMarkdown(source,raw,1),raw);
  const unsupported='```mermaid\nnot a diagram\n```';assert.equal(diagramMarkdown('not a diagram',unsupported,80),unsupported);
});

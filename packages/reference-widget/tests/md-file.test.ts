import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedOnDisk, openMdFile, saveMdFile } from '../src/md-file.ts';

async function folder(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'md-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a missing file opens empty and is created on save with a trailing newline', async t => {
  const dir = await folder(t), path = join(dir, 'new.md');
  const file = await openMdFile(path);
  assert.deepEqual([file.exists, file.text], [false, '']);
  const saved = await saveMdFile(file, '# Title');
  assert.equal(await readFile(path, 'utf8'), '# Title\n');
  assert.equal(saved.exists, true);
  assert.deepEqual(await readdir(dir), ['new.md'], 'nothing else appears beside the document');
});

test('saving keeps CRLF line endings and file permissions', async t => {
  const dir = await folder(t), path = join(dir, 'doc.md');
  await writeFile(path, 'a\r\nb\r\n');
  await chmod(path, 0o600);
  const file = await openMdFile(path);
  await saveMdFile(file, 'a\nb\nc\n');
  assert.equal(await readFile(path, 'utf8'), 'a\r\nb\r\nc\r\n');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a symlinked document is saved through to its target', async t => {
  const dir = await folder(t), target = join(dir, 'real.md'), link = join(dir, 'link.md');
  await writeFile(target, 'old\n');
  await symlink(target, link);
  await saveMdFile(await openMdFile(link), 'new\n');
  assert.equal(await readFile(target, 'utf8'), 'new\n');
  assert.ok((await import('node:fs')).lstatSync(link).isSymbolicLink());
});

test('outside edits are detected; directories, large and binary files are refused', async t => {
  const dir = await folder(t), path = join(dir, 'doc.md');
  await writeFile(path, 'x\n');
  const file = await openMdFile(path);
  assert.equal(await changedOnDisk(file), false);
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  assert.equal(await changedOnDisk(file), true);
  await assert.rejects(openMdFile(dir), /not a file/);
  await writeFile(join(dir, 'bin.md'), 'a\0b');
  await assert.rejects(openMdFile(join(dir, 'bin.md')), /binary/);
  await writeFile(join(dir, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(openMdFile(join(dir, 'big.md')), /larger than 2 MB/);
  await assert.rejects(openMdFile(join(dir, 'missing', 'x.md')), /does not exist/);
  // /dev is its own file system on macOS and Linux, standing in for an external volume.
  await assert.rejects(openMdFile('/dev/pi-md-test.md'), /another volume/);
});

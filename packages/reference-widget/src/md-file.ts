import { randomBytes } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const MAX_BYTES = 2 * 1024 * 1024;

/** What /md knows about the file on disk: enough to save safely and detect outside edits. */
export type MdFile = { path: string; text: string; exists: boolean; mtimeMs?: number; crlf: boolean };

/**
 * Saving renames a temporary file from the system temp folder onto the document, which is only
 * atomic within one volume. /md therefore edits only files on the temp folder's volume.
 */
async function assertSameVolume(path: string) {
  const folder = dirname(path);
  let device: number;
  try { device = (await stat(folder)).dev; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Folder ${folder} does not exist.`);
    throw error;
  }
  if (device !== (await stat(tmpdir())).dev) throw new Error(`${basename(path)} is on another volume; /md only edits files on the main disk.`);
}

export async function openMdFile(requested: string): Promise<MdFile> {
  let file: MdFile;
  try {
    // Edit a symlink's target, so saving does not replace the link with a regular file.
    const path = await realpath(requested);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${basename(path)} is not a file.`);
    if (info.size > MAX_BYTES) throw new Error(`${basename(path)} is larger than 2 MB.`);
    const raw = await readFile(path, 'utf8');
    if (raw.includes('\0')) throw new Error(`${basename(path)} looks like a binary file.`);
    file = { path, text: raw, exists: true, mtimeMs: info.mtimeMs, crlf: raw.includes('\r\n') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    file = { path: requested, text: '', exists: false, crlf: false };
  }
  await assertSameVolume(file.path);
  return file;
}

/** True when the file changed on disk (or appeared) since it was opened or last saved. */
export async function changedOnDisk(file: MdFile) {
  try { return (await stat(file.path)).mtimeMs !== file.mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return file.exists; throw error; }
}

/**
 * Writes a flushed temporary file in the system temp folder, then renames it onto the document,
 * so a crash or power loss never leaves a half-written file. Keeps line endings and permissions,
 * and ends the file with a newline.
 */
export async function saveMdFile(file: MdFile, text: string): Promise<MdFile> {
  await assertSameVolume(file.path);
  const body = (text.endsWith('\n') || !text ? text : text + '\n').replace(/\n/g, file.crlf ? '\r\n' : '\n');
  const mode = file.exists ? ((await stat(file.path).catch(() => undefined))?.mode ?? 0o644) & 0o7777 : 0o644;
  const temp = join(tmpdir(), `pi-md-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, file.path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error(`${basename(file.path)} is on another volume; /md only edits files on the main disk.`);
    throw error;
  }
  return { ...file, text, exists: true, mtimeMs: (await stat(file.path)).mtimeMs };
}

import { randomBytes } from 'node:crypto';
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const MAX_BYTES = 2 * 1024 * 1024;

/** What /md knows about the file on disk: enough to save safely and detect outside edits. */
export type MdFile = { path: string; text: string; exists: boolean; mtimeMs?: number; crlf: boolean };

export async function openMdFile(requested: string): Promise<MdFile> {
  try {
    // Edit a symlink's target, so saving does not replace the link with a regular file.
    const path = await realpath(requested);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${basename(path)} is not a file.`);
    if (info.size > MAX_BYTES) throw new Error(`${basename(path)} is larger than 2 MB.`);
    const raw = await readFile(path, 'utf8');
    if (raw.includes('\0')) throw new Error(`${basename(path)} looks like a binary file.`);
    return { path, text: raw, exists: true, mtimeMs: info.mtimeMs, crlf: raw.includes('\r\n') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A missing parent directory is reported on save rather than created silently.
    return { path: requested, text: '', exists: false, crlf: false };
  }
}

/** True when the file changed on disk (or appeared) since it was opened or last saved. */
export async function changedOnDisk(file: MdFile) {
  try { return (await stat(file.path)).mtimeMs !== file.mtimeMs; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return file.exists; throw error; }
}

/**
 * Writes through a temporary file and rename, so a crash never leaves a half-written document.
 * Keeps the file's original line endings and ends it with a newline.
 */
export async function saveMdFile(file: MdFile, text: string): Promise<MdFile> {
  const body = (text.endsWith('\n') || !text ? text : text + '\n').replace(/\n/g, file.crlf ? '\r\n' : '\n');
  const temp = join(dirname(file.path), `.${basename(file.path)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const mode = file.exists ? (await stat(file.path).catch(() => undefined))?.mode : undefined;
    await writeFile(temp, body, { encoding: 'utf8', flag: 'wx', mode: mode === undefined ? 0o644 : mode & 0o7777 });
    await rename(temp, file.path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Folder ${dirname(file.path)} does not exist.`);
    throw error;
  }
  return { ...file, text, exists: true, mtimeMs: (await stat(file.path)).mtimeMs };
}

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** One Markdown note shared by every Pi agent; it reaches each model only when it changes. */
export const NOTES_MESSAGE_TYPE = 'busywork-notes';
export const NOTES_MARKER = '<!-- busywork notes: every Pi agent sees changes to this file. -->';
/** Keeps an accidental paste from flooding every agent's context. */
export const MAX_NOTE_CHARS = 20_000;

export type NotesConfig = { path?: string };
export type Note = { path: string; body: string; hash: string; exists: boolean };

export function parseNotesConfig(value: unknown): NotesConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('notes config must be an object.');
  const path = (value as any).path;
  if (path !== undefined && (typeof path !== 'string' || !path.trim())) throw new Error('notes.path must be a non-empty string.');
  return path === undefined ? {} : { path: path.trim() };
}

export function notesPath(config: NotesConfig, agentDir: string) {
  if (!config.path) return join(agentDir, 'busywork', 'notes.md');
  const path = config.path === '~' || config.path.startsWith('~/') ? join(homedir(), config.path.slice(1)) : config.path;
  if (!isAbsolute(path)) throw new Error('notes.path must be absolute or start with ~/.');
  return path;
}

/** The note as the model sees it: no marker line, no surrounding blank lines, Unix newlines. */
export function noteBody(text: string) {
  return text.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim() !== NOTES_MARKER).join('\n').trim();
}

/** The file as stored: the marker first, then the body. */
export function withMarker(text: string) {
  const body = noteBody(text);
  return `${NOTES_MARKER}\n${body ? `\n${body}\n` : ''}`;
}

export const noteHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 12);

export async function readNote(path: string): Promise<Note> {
  try {
    const body = noteBody(await readFile(path, 'utf8'));
    return { path, body, hash: noteHash(body), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path, body: '', hash: noteHash(''), exists: false };
  }
}

function checkSize(body: string) {
  if (body.length > MAX_NOTE_CHARS) throw new Error(`Notes would exceed ${MAX_NOTE_CHARS} characters; shorten them first.`);
}

/**
 * Adds text to the end without rewriting what is there, so concurrent appends from
 * several agents both survive. Creates the file, with its marker, when missing.
 */
export async function appendNote(path: string, text: string): Promise<Note> {
  const addition = text.replace(/\r\n?/g, '\n').trim();
  if (!addition) throw new Error('Nothing to append.');
  checkSize(`${(await readNote(path)).body}\n${addition}`);
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, `${NOTES_MARKER}\n`, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const handle = await open(path, 'r');
  let endsWithNewline = true;
  try {
    const { size } = await handle.stat();
    if (size) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); endsWithNewline = last[0] === 0x0a; }
  } finally { await handle.close(); }
  await appendFile(path, `${endsWithNewline ? '' : '\n'}\n${addition}\n`);
  return readNote(path);
}

export class NoteChangedError extends Error {
  readonly current: Note;
  constructor(current: Note) { super('Notes changed since they were read; read them again before replacing.'); this.current = current; }
}

/** Rewrites the whole note only if it still matches the version the writer read. */
export async function replaceNote(path: string, text: string, expectedHash: string): Promise<Note> {
  const current = await readNote(path);
  if (current.hash !== expectedHash) throw new NoteChangedError(current);
  checkSize(noteBody(text));
  await mkdir(dirname(path), { recursive: true });
  // A temporary file in the same folder, renamed over the note, so a crash never leaves half a note.
  const temp = join(dirname(path), `.notes-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const mode = current.exists ? (await stat(path)).mode & 0o7777 : 0o644;
    await writeFile(temp, withMarker(text), { flag: 'wx', mode });
    await rename(temp, path);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return readNote(path);
}

/** The hash of the note this model last saw, from the entries still in its context. */
export function lastSentHash(contextEntries: readonly any[]): string | undefined {
  for (let i = contextEntries.length - 1; i >= 0; i--) {
    const entry = contextEntries[i];
    if (entry?.type === 'custom_message' && entry.customType === NOTES_MESSAGE_TYPE && typeof entry.details?.hash === 'string') return entry.details.hash;
  }
  return undefined;
}

/** The context message announcing a changed note, or nothing when the model already has this version. */
export function noteUpdate(note: Note, sentHash: string | undefined) {
  if (note.hash === sentHash) return undefined;
  if (sentHash === undefined && !note.body) return undefined;
  const content = note.body
    ? `Shared notes updated (${note.path}). Every Pi agent sees these notes; this replaces any earlier version.\n\n${note.body}`
    : 'Shared notes were cleared.';
  return { customType: NOTES_MESSAGE_TYPE, content, display: false, details: { hash: note.hash } };
}

export function notesStatusText(note: Pick<Note, 'body'>) {
  if (!note.body) return '📝 No notes';
  const lines = note.body.split('\n').filter(line => line.trim()).length;
  return `📝 Notes · ${lines} line${lines === 1 ? '' : 's'}`;
}

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export type Section = 'review' | 'waiting';
export type Priority = 'high' | 'medium' | 'low';
export const SECTIONS: Section[] = ['review', 'waiting'];
export const PRIORITIES: Priority[] = ['high', 'medium', 'low'];
export const MAX_NOTE_CHARS = 4000;
export const MAX_ADDED_BY_CHARS = 60;

/** A pull request reference: `owner/repo` on github.com, `host/owner/repo` elsewhere. */
export type PrRef = { host: string; owner: string; repo: string; number: number; repoId: string; id: string; url: string };

export type Entry = {
  id: string;
  repo: string;
  number: number;
  url: string;
  section: Section;
  priority?: Priority;
  note?: string;
  addedBy?: string;
  addedAt: string;
  updatedAt: string;
};
export type Queue = { version: 1; entries: Entry[] };
export const emptyQueue = (): Queue => ({ version: 1, entries: [] });

const NAME = /^[\w.-]+$/;

/** Accepts a PR URL (`https://host/owner/repo/pull/12`), `host/owner/repo#12` or `owner/repo#12`. */
export function parseRef(input: string): PrRef {
  const text = String(input ?? '').trim();
  let host: string, owner: string, repo: string, num: string;
  const url = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(text);
  const short = /^(?:([^/\s#]+)\/)?([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  if (url) [, host, owner, repo, num] = url;
  else if (short) { [, host, owner, repo, num] = short; host ??= 'github.com'; }
  else throw new Error(`Not a pull request reference: "${text}". Use a PR URL or owner/repo#123.`);
  if (![owner, repo].every(part => NAME.test(part)) || !/^[\w.-]+(?::\d+)?$/.test(host)) throw new Error(`Not a pull request reference: "${text}".`);
  host = host.toLowerCase();
  const number = Number(num);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid pull request number in "${text}".`);
  const repoId = (host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}`).toLowerCase();
  return { host, owner, repo, number, repoId, id: `${repoId}#${number}`, url: `https://${host}/${owner}/${repo}/pull/${number}` };
}

export type EntryChanges = { section?: Section; priority?: Priority | null; note?: string | null; addedBy?: string };

function checkChanges(changes: EntryChanges) {
  if (changes.section !== undefined && !SECTIONS.includes(changes.section)) throw new Error(`section must be one of ${SECTIONS.join(', ')}.`);
  if (changes.priority != null && !PRIORITIES.includes(changes.priority)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}.`);
  if (changes.note != null && changes.note.length > MAX_NOTE_CHARS) throw new Error(`note must be at most ${MAX_NOTE_CHARS} characters.`);
  if (changes.addedBy !== undefined && (!changes.addedBy.trim() || changes.addedBy.length > MAX_ADDED_BY_CHARS))
    throw new Error(`addedBy must be 1–${MAX_ADDED_BY_CHARS} characters.`);
}

function apply(entry: Entry, changes: EntryChanges, now: string): Entry {
  const next = { ...entry, updatedAt: now };
  if (changes.section !== undefined) next.section = changes.section;
  if (changes.priority !== undefined) { if (changes.priority === null) delete next.priority; else next.priority = changes.priority; }
  if (changes.note !== undefined) { const note = changes.note?.trim(); if (note) next.note = note; else delete next.note; }
  if (changes.addedBy !== undefined) next.addedBy = changes.addedBy.trim();
  return next;
}

/** Adds a PR, or updates it in place when it is already queued, so repeated adds never duplicate. */
export function addEntry(queue: Queue, ref: PrRef, changes: EntryChanges, now = new Date().toISOString()) {
  checkChanges(changes);
  const existing = queue.entries.find(entry => entry.id === ref.id);
  if (existing) {
    const entries = queue.entries.map(entry => entry.id === ref.id ? apply(entry, changes, now) : entry);
    return { queue: { ...queue, entries }, added: false, entry: entries.find(entry => entry.id === ref.id)! };
  }
  const entry = apply({ id: ref.id, repo: ref.repoId, number: ref.number, url: ref.url, section: 'review', addedAt: now, updatedAt: now }, changes, now);
  return { queue: { ...queue, entries: [...queue.entries, entry] }, added: true, entry };
}

export function updateEntry(queue: Queue, ref: PrRef, changes: EntryChanges, now = new Date().toISOString()) {
  checkChanges(changes);
  if (!queue.entries.some(entry => entry.id === ref.id)) throw new Error(`${ref.id} is not in the queue.`);
  const entries = queue.entries.map(entry => entry.id === ref.id ? apply(entry, changes, now) : entry);
  return { queue: { ...queue, entries }, entry: entries.find(entry => entry.id === ref.id)! };
}

export function removeEntry(queue: Queue, id: string) {
  const entries = queue.entries.filter(entry => entry.id !== id);
  if (entries.length === queue.entries.length) throw new Error(`${id} is not in the queue.`);
  return { ...queue, entries };
}

function validEntry(value: any): value is Entry {
  return value && typeof value.id === 'string' && typeof value.repo === 'string' && Number.isSafeInteger(value.number)
    && typeof value.url === 'string' && SECTIONS.includes(value.section) && typeof value.addedAt === 'string';
}

export function parseQueue(text: string): Queue {
  const data = JSON.parse(text);
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Unrecognized PR queue file.');
  return { version: 1, entries: data.entries.filter(validEntry) };
}

export async function readQueue(path: string): Promise<Queue> {
  try { return parseQueue(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyQueue(); throw error; }
}

async function writeQueue(path: string, queue: Queue) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(queue, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Several Pi sessions share the file: changes run one at a time under a lock file. */
export async function updateQueue<T>(path: string, change: (queue: Queue) => { queue: Queue; result: T }, staleMs = 10_000): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  for (let attempt = 0; ; attempt++) {
    try { await (await open(lock, 'wx')).close(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > staleMs) { await unlink(lock).catch(() => {}); continue; } } catch {}
      if (attempt > 100) throw new Error('The PR queue is locked by another session; try again.');
      await sleep(50);
    }
  }
  try {
    const { queue, result } = change(await readQueue(path));
    await writeQueue(path, queue);
    return result;
  } finally { await unlink(lock).catch(() => {}); }
}

import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export const STATE_TYPE = 'pi-reference-widget-state';
export const MAX_BYTES = 2 * 1024 * 1024;
export type Snapshot = { path: string; name: string; text?: string; hash?: string; error?: string };
export type Note = { path: string; name: string; hash: string; excerpt: string; comment: string };
export const safeText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

export function resolvePath(input: string, cwd: string): string {
  if (!input.trim() || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Supply a file path without control characters.');
  return resolve(cwd, input.startsWith('~/') ? homedir() + input.slice(1) : input);
}
export function commandPath(args: string): string | undefined {
  const value = args.trim();
  if (!value) return undefined;
  if (value.startsWith('"') || value.startsWith("'")) {
    if (value.at(-1) !== value[0] || value.length < 2) throw new Error('Close the quote around the file path.');
    return value.slice(1, -1);
  }
  return value;
}
export async function addPath(input: string, cwd: string): Promise<string> {
  const path = await realpath(resolvePath(input, cwd));
  if (!['.md', '.markdown'].includes(extname(path).toLowerCase())) throw new Error('References must be Markdown files (.md or .markdown).');
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Reference must be a regular file.');
    if (stat.size > MAX_BYTES) throw new Error('Reference exceeds the 2 MiB reader limit.');
  } finally { await handle.close(); }
  return path;
}
export async function readSnapshot(path: string): Promise<Snapshot> {
  const name = basename(path);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Not a regular file.');
      // Bound reads even if the file grows after registration.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_BYTES) throw new Error('File exceeds the 2 MiB reader limit.');
      bytes = buffer.subarray(0, size);
    } finally { await handle.close(); }
    return { path, name, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hash: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) { return { path, name, error: `Cannot read ${safeText(name)}: ${(error as Error).message}` }; }
}
export function restore(entries: any[]): string[] {
  const entry = entries.findLast(e => e.type === 'custom' && e.customType === STATE_TYPE);
  if (!entry) return [];
  const data = entry.data;
  if (data?.version !== 1 || !Array.isArray(data.paths) || data.paths.some(p => typeof p !== 'string' || !isAbsolute(p)) || new Set(data.paths).size !== data.paths.length)
    throw new Error('Invalid saved reference list; no changes made.');
  return [...data.paths];
}
export function labels(paths: string[]): string[] {
  const names = paths.map(p => safeText(basename(p)));
  const seen = new Map<string, number>();
  return names.map(name => {
    const index = (seen.get(name) ?? 0) + 1; seen.set(name, index);
    return names.filter(n => n === name).length > 1 ? `${name} (${index})` : name;
  });
}
export function excerpt(lines: string[], anchor: number | undefined, cursor: number): string {
  if (anchor === undefined || !lines.length) throw new Error('Select displayed text before adding a comment.');
  const start = Math.max(0, Math.min(anchor, cursor)), end = Math.min(lines.length - 1, Math.max(anchor, cursor));
  const text = lines.slice(start, end + 1).map(line => stripVTControlCharacters(line).trimEnd()).join('\n');
  if (!text.trim()) throw new Error('Select nonempty displayed text.');
  return text;
}
export function feedback(notes: Note[]): string {
  if (!notes.length) throw new Error('Add at least one comment before Ready.');
  return '---\nComments on reference files (quoted excerpts are rendered text, not source line coordinates):\n\n' + notes.map(note =>
    `File: ${safeText(note.name)}\nPath: ${safeText(note.path)}\nContent SHA-256: ${note.hash}\n\n${safeText(note.excerpt).split('\n').map(l => '> ' + l).join('\n')}\n\n${safeText(note.comment)}`
  ).join('\n\n') + '\n---';
}

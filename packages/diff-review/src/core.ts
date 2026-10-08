import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';

const run = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
export const safeText = text => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).replace(/\t/g, '    ');
export const expandHome = path => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
export async function git(cwd, args, binary = false) {
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
export function parseArgs(text) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (!(parts.length === 1 || (parts.length === 3 && parts[1] === '--base'))) throw new Error('Usage: /d <branch-substring> [--base <ref>]');
  if (parts[0].startsWith('-') || parts[0].includes('\0')) throw new Error('Supply a literal branch substring, not an option.');
  if (parts[2]?.startsWith('-')) throw new Error('Invalid base ref.');
  return { pattern: parts[0], base: parts[2] };
}
export async function loadConfig(path) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.repositories) || !config.repositories.length) throw new Error('Config requires version 1 and at least one repository.');
  for (const r of config.repositories) {
    if (!r.name || typeof r.path !== 'string' || typeof r.defaultBase !== 'string' || r.defaultBase.startsWith('-')) throw new Error('Each repository needs name, path and defaultBase.');
  }
  const prefixes = config.ticketPrefixes ?? [];
  if (!Array.isArray(prefixes) || prefixes.some(prefix =>
    typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix))) {
    throw new Error('ticketPrefixes must contain project keys without hyphens, such as PROJ.');
  }
  return { ...config, ticketPrefixes: [...new Set(prefixes.map(prefix => prefix.toUpperCase()))] };
}
export function parseWorktrees(text) {
  const entries = []; let current;
  for (const record of text.split('\0')) {
    if (record.startsWith('worktree ')) { current = { path: record.slice(9) }; entries.push(current); }
    else if (record.startsWith('branch ') && current) current.branch = record.slice(7).replace(/^refs\/heads\//, '');
    else if (record.startsWith('prunable') && current) current.prunable = true;
  }
  return entries;
}
export function ticketIds(text, prefixes = []) {
  if (!prefixes.length) return [];
  const keys = prefixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])(${keys})-(\\d+)(?![A-Za-z0-9])`, 'gi');
  return [...new Set([...text.matchAll(pattern)].map(match => `${match[1].toUpperCase()}-${match[2]}`))];
}
export function branchMatches(branch, pattern, ticketPrefixes = []) {
  const tickets = ticketIds(pattern, ticketPrefixes);
  if (tickets.length > 1) throw new Error('Specify one ticket ID for diff review.');
  return tickets.length ? ticketIds(branch, ticketPrefixes).includes(tickets[0]) : branch.includes(pattern);
}
export async function resolveTarget(config, pattern) {
  // Validate multi-ticket input even if the configured repositories have no live worktrees.
  branchMatches('', pattern, config.ticketPrefixes);
  const matches = [], seen = new Set();
  for (const repository of config.repositories) {
    const root = expandHome(repository.path);
    let records;
    try { records = parseWorktrees(await git(root, ['worktree', 'list', '--porcelain', '-z'])); }
    catch { throw new Error(`Cannot inspect configured repository ${repository.name}: ${root}`); }
    for (const record of records) {
      if (record.prunable || !record.branch || !branchMatches(record.branch, pattern, config.ticketPrefixes)) continue;
      let path;
      try { path = await realpath(record.path); } catch { continue; }
      if (seen.has(path)) continue;
      seen.add(path); matches.push({ ...record, path, repository });
    }
  }
  if (!matches.length) throw new Error(`No checked-out branch matches "${pattern}".`);
  if (matches.length !== 1) throw new Error(`Multiple worktrees match "${pattern}":\n${matches.map(m => `${m.branch} — ${m.path}`).join('\n')}`);
  return matches[0];
}
function parseStatus(text) {
  const fields = text.split('\0'); const files = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++]; const path = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) files.push({ status, oldPath: path, path: fields[i++] });
    else files.push({ status, oldPath: status === 'A' ? null : path, path: status === 'D' ? null : path });
  }
  return files;
}
function textContent(buffer) {
  if (buffer.length > MAX_BYTES) return { reason: 'Oversized file (over 1 MiB).' };
  if (buffer.includes(0)) return { reason: 'Binary file.' };
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) return { reason: 'Non-UTF-8 file.' };
  return { text, hash: hash(buffer) };
}
async function oldContent(target, mergeBase, path) {
  if (path === null) return { text: '', hash: null };
  const metadata = await git(target.path, ['ls-tree', '-z', mergeBase, '--', path]);
  const mode = metadata.split(' ')[0];
  if (mode !== '100644' && mode !== '100755') return { reason: 'Symlink, submodule, or unsupported Git entry.' };
  const size = Number((await git(target.path, ['cat-file', '-s', `${mergeBase}:${path}`])).trim());
  if (size > MAX_BYTES) return { reason: 'Oversized file (over 1 MiB).' };
  return textContent(await git(target.path, ['show', `${mergeBase}:${path}`], true));
}
async function newContent(target, path) {
  if (path === null) return { text: '', hash: null };
  const absolute = resolve(target.path, path);
  if (!absolute.startsWith(target.path + sep)) throw new Error('File path escapes the worktree.');
  const stat = await lstat(absolute);
  if (!stat.isFile()) return { reason: 'Symlink, submodule, or non-regular file.' };
  const canonical = await realpath(absolute);
  if (!canonical.startsWith(target.path + sep)) return { reason: 'File resolves outside the worktree.' };
  if (stat.size > MAX_BYTES) return { reason: 'Oversized file (over 1 MiB).' };
  return textContent(await readFile(absolute));
}
export function diffRows(oldText, newText, oldPath, path) {
  const patch = structuredPatch(oldPath ?? '/dev/null', path ?? '/dev/null', oldText, newText, '', '', { context: 3 });
  const rows = [];
  for (const h of patch.hunks) {
    const oldStart = h.oldLines === 0 ? Math.max(0, h.oldStart - 1) : h.oldStart;
    const newStart = h.newLines === 0 ? Math.max(0, h.newStart - 1) : h.newStart;
    rows.push({ kind: 'hunk', text: `@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@` });
    let oldLine = h.oldStart, newLine = h.newStart;
    for (const line of h.lines) {
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'delete' : line[0] === ' ' ? 'context' : 'meta';
      const row = { kind, text: line.slice(kind === 'meta' ? 0 : 1) };
      if (kind === 'delete' || kind === 'context') row.oldLine = oldLine++;
      if (kind === 'add' || kind === 'context') row.newLine = newLine++;
      rows.push(row);
    }
  }
  return rows;
}
export async function snapshot(target, baseOverride) {
  const base = baseOverride ?? target.repository.defaultBase;
  const baseCommit = (await git(target.path, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const headCommit = (await git(target.path, ['rev-parse', 'HEAD'])).trim();
  const common = (await git(target.path, ['merge-base', '--all', baseCommit, headCommit])).trim().split('\n');
  if (common.length !== 1 || !common[0]) throw new Error('Cannot determine a unique merge base.');
  const mergeBaseCommit = common[0];
  if ((await git(target.path, ['diff', '--name-only', '--diff-filter=U', '-z'])).length) throw new Error('Resolve merge conflicts before reviewing.');
  const changed = parseStatus(await git(target.path, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', mergeBaseCommit, '--']));
  const tracked = new Set(changed.map(f => f.path).filter(Boolean));
  const untracked = (await git(target.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const path of untracked) if (!tracked.has(path)) changed.push({ status: 'untracked', oldPath: null, path });
  const files = [];
  for (const info of changed) {
    const old = await oldContent(target, mergeBaseCommit, info.oldPath);
    let next;
    try { next = await newContent(target, info.path); }
    catch (e) { if (e.code === 'ENOENT') throw new Error(`File changed during capture: ${info.path}. Run /d again.`); throw e; }
    const reason = old.reason ?? next.reason;
    const rows = reason ? [] : diffRows(old.text, next.text, info.oldPath, info.path);
    // Mode-only changes are still reviewable at file level but have no selectable text.
    files.push({ ...info, oldHash: old.hash ?? null, newHash: next.hash ?? null, reason,
      rows: rows.length ? rows : [{ kind: 'meta', text: reason ?? 'No text changes (mode or metadata change).' }],
      oldLines: old.text?.split('\n') ?? [], newLines: next.text?.split('\n') ?? [] });
  }
  const commitPrefixes = Object.fromEntries(await Promise.all([...new Set([baseCommit, mergeBaseCommit, headCommit])].map(async sha =>
    [sha, (await git(target.path, ['rev-parse', '--short=7', sha])).trim()])));
  return { version: 1, repository: target.repository.name, worktree: target.path, branch: target.branch,
    base, baseCommit, mergeBaseCommit, headCommit, commitPrefixes, capturedAt: new Date().toISOString(), files };
}
export function selectedExcerpt(file, anchor, cursor) {
  const startRow = Math.min(anchor, cursor), endRow = Math.max(anchor, cursor);
  if (startRow < 0 || endRow >= file.rows.length) throw new Error('Selection is outside the diff.');
  const rows = file.rows.slice(startRow, endRow + 1);
  if (file.reason || !rows.some(row => ['add', 'delete', 'context'].includes(row.kind)))
    throw new Error('Select at least one code line.');
  const excerpt = [];
  // Supply the enclosing header even when selection starts midway through a hunk.
  if (rows[0].kind !== 'hunk') {
    for (let i = startRow - 1; i >= 0; i--) {
      if (file.rows[i].kind === 'hunk') { excerpt.push(file.rows[i].text); break; }
    }
  }
  for (const row of rows) {
    const prefix = row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : row.kind === 'context' ? ' ' : '';
    excerpt.push(prefix + row.text);
  }
  return { startRow, endRow, excerpt: excerpt.join('\n') };
}
export function contentHashPrefixes(hashes) {
  const unique = [...new Set(hashes.filter(Boolean))];
  return new Map(unique.map(hash => {
    let length = 7;
    while (length < hash.length && unique.some(other => other !== hash && other.startsWith(hash.slice(0, length)))) length++;
    return [hash, hash.slice(0, length)];
  }));
}
export function preparedReview(snapshot, comments) {
  return '---\n' + reviewJSON(snapshot, comments) + '\n---';
}
export function reviewJSON(snapshot, comments) {
  if (!comments.length) throw new Error('Add at least one comment before Ready.');
  const { files, commitPrefixes, ...metadata } = snapshot;
  const prefixes = contentHashPrefixes(files.flatMap(file => [file.oldHash, file.newHash]));
  for (const key of ['baseCommit', 'mergeBaseCommit', 'headCommit']) metadata[key] = commitPrefixes?.[metadata[key]] ?? metadata[key];
  return JSON.stringify({ ...metadata, version: 2, scope: 'merge-base-to-working-tree', comments: comments.map(note => {
    const file = files[note.fileIndex];
    return { file: file.path ?? file.oldPath, oldPath: file.oldPath, newPath: file.path,
      oldContentHashPrefix: prefixes.get(file.oldHash) ?? null, newContentHashPrefix: prefixes.get(file.newHash) ?? null, excerpt: note.selection.excerpt, comment: note.comment };
  }) }, null, 2);
}

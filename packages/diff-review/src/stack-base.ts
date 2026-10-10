import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function catalog(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read gh-stack catalog ${path}: ${error.message}`);
  }
}

// gh-stack v0.2.0 uses schema 1 in the common Git directory. Reading the
// catalog avoids view --json's PR refresh, save, and legacy migration writes.
export function parentFromCatalog(data: any, branch: string): { base: string; baseSource: string } | undefined {
  if (data.schemaVersion !== 1 || !Array.isArray(data.stacks)) throw new Error('Unsupported gh-stack catalog; expected schemaVersion 1.');
  const matches: any[] = [];
  for (const stack of data.stacks) {
    if (typeof stack.trunk?.branch !== 'string' || !Array.isArray(stack.branches)
      || stack.branches.some((entry: any) => typeof entry.branch !== 'string')) throw new Error('Malformed gh-stack catalog.');
    const names = [stack.trunk.branch, ...stack.branches.map((entry: any) => entry.branch)];
    if (new Set(names).size !== names.length) throw new Error('Duplicate branch in gh-stack catalog.');
    if (names.includes(branch)) matches.push(stack);
  }
  if (matches.length > 1) throw new Error(`Branch ${branch} belongs to multiple gh-stack stacks.`);
  if (!matches.length) return undefined;
  const stack = matches[0];
  const index = stack.branches.findIndex((entry: any) => entry.branch === branch);
  // A trunk isn't a layer in this stack; its own review uses the repo default.
  if (index < 0) return undefined;
  return { base: index === 0 ? stack.trunk.branch : stack.branches[index - 1].branch,
    baseSource: index === 0 ? 'stack-trunk' : 'stack-parent' };
}

export async function resolveReviewBase(target: any, override: string | undefined, git: Function) {
  if (override !== undefined) return { base: override, baseSource: 'explicit' };
  const commonDir = (await git(target.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  // Legacy per-worktree catalogs need gh-stack's explicit migration, never an
  // implicit write from a review operation.
  let worktrees: string[] = [];
  try { worktrees = await readdir(join(commonDir, 'worktrees')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  for (const name of worktrees) {
    if (await catalog(join(commonDir, 'worktrees', name, 'gh-stack')) !== undefined)
      throw new Error('Legacy gh-stack worktree catalog found. Migrate with gh stack, or specify --base explicitly.');
  }
  const data = await catalog(join(commonDir, 'gh-stack'));
  const parent = data === undefined ? undefined : parentFromCatalog(data, target.branch);
  const result = parent ?? { base: target.repository.defaultBase, baseSource: 'configured-default' };
  if (typeof result.base !== 'string' || !result.base || result.base.startsWith('-')) throw new Error('Invalid review base in stack metadata.');
  if (result.baseSource.startsWith('stack-')) {
    try { await git(target.path, ['show-ref', '--verify', `refs/heads/${result.base}`]); }
    catch { throw new Error(`Stack base branch ${result.base} is missing locally. Restore it or specify --base explicitly.`); }
  }
  return result;
}

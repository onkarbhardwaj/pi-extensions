import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Entry } from './queue.ts';

export type CiState = 'running' | 'failed' | 'passed';
export type Review = 'merged' | 'closed' | 'draft' | 'changes' | 'conflict' | 'approved' | 'required';
export type PrStatus = {
  title: string; author?: string; state: string; createdAt?: string;
  ci?: CiState; review: Review; failedChecks: string[]; checkedAt: number;
};
export type StatusResult = { status?: PrStatus; error?: string; checkedAt: number };

export const CI_ICON: Record<CiState, string> = { running: '⏳', failed: '❌', passed: '✅' };
export const REVIEW_TEXT: Record<Review, string> = {
  merged: '🔀 Merged', closed: 'Closed', draft: 'Draft', changes: '❗ Changes requested',
  conflict: '❗ Conflict', approved: '👍 Approved', required: 'Review required',
};
/** Approved, merged and closed PRs need nothing more from a reviewer. */
export const isDone = (status: PrStatus | undefined) => !!status && ['merged', 'closed', 'approved'].includes(status.review);

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const checkName = (check: any) => String(check.name ?? check.context ?? '');

/** Ignore entries match a whole check name or its job suffix after ': '. */
export function relevantChecks(checks: any[] | undefined, ignore: string[] = []) {
  const ignored = new Set(ignore.map(name => name.toLowerCase()));
  return (checks ?? []).filter(check => {
    const name = checkName(check).toLowerCase();
    return !ignored.has(name) && !ignored.has(name.split(': ').at(-1)!);
  });
}

export function ciState(checks: any[]): CiState | undefined {
  if (!checks.length) return undefined;
  const results = checks.map(check => String(check.conclusion ?? check.state ?? '').toUpperCase());
  const statuses = checks.map(check => String(check.status ?? '').toUpperCase());
  if (results.some(r => FAILED.includes(r))) return 'failed';
  if (results.some((r, i) => !r || ['PENDING', 'EXPECTED'].includes(r) || ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'].includes(statuses[i]))) return 'running';
  return 'passed';
}

export function reviewOf(pr: any): Review {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  if (pr.mergeable === 'CONFLICTING') return 'conflict';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  return 'required';
}

export function toStatus(pr: any, ignore: string[] = [], checkedAt = Date.now()): PrStatus {
  const checks = relevantChecks(pr.statusCheckRollup, ignore);
  return {
    title: String(pr.title ?? ''), author: pr.author?.login || undefined, state: String(pr.state ?? ''),
    createdAt: pr.createdAt || undefined, review: reviewOf(pr),
    ci: pr.state === 'OPEN' ? ciState(checks) : undefined,
    failedChecks: pr.state === 'OPEN' ? checks.filter(check => FAILED.includes(String(check.conclusion ?? check.state ?? '').toUpperCase())).map(checkName) : [],
    checkedAt,
  };
}

/** Changes worth a notification: CI turned red, review needs action, or the PR merged. */
export function notableChange(label: string, before: PrStatus | undefined, after: PrStatus) {
  if (!before) return [];
  const messages: string[] = [];
  if (after.ci === 'failed' && before.ci !== 'failed') messages.push(`${label}: CI failed`);
  if ((after.review === 'changes' || after.review === 'conflict') && after.review !== before.review) messages.push(`${label}: ${REVIEW_TEXT[after.review].slice(2)}`);
  if (after.review === 'merged' && before.review !== 'merged') messages.push(`${label}: merged`);
  return messages;
}

export type Config = { ci: Record<string, { ignore: string[] }> };

/** CI settings are keyed by owner/repo, whichever GitHub host the repository lives on. */
export const repoKey = (repo: string) => repo.toLowerCase().split('/').slice(-2).join('/');

export function parseConfig(value: unknown): Config {
  if (value === undefined || value === null) return { ci: {} };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('pr-queue config must be an object.');
  const ci = (value as any).ci ?? {};
  if (typeof ci !== 'object' || Array.isArray(ci)) throw new Error('ci must map owner/repo names to CI settings.');
  const result: Config['ci'] = {};
  for (const [repo, settings] of Object.entries(ci)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`ci key ${repo} must be owner/repo.`);
    const ignore = (settings as any)?.ignore ?? [];
    if (!Array.isArray(ignore) || ignore.some(name => typeof name !== 'string')) throw new Error(`ci.${repo}.ignore must be an array of check names.`);
    result[repo.toLowerCase()] = { ignore };
  }
  return { ci: result };
}

export async function loadConfig(path: string): Promise<Config> {
  try { return parseConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ci: {} }; throw error; }
}

const FIELDS = 'title,url,author,state,isDraft,reviewDecision,mergeable,statusCheckRollup,createdAt';

export function fetchStatus(entry: Entry, config: Config): Promise<PrStatus> {
  return new Promise((resolve, reject) => execFile('gh', ['pr', 'view', String(entry.number), '--repo', entry.repo, '--json', FIELDS],
    { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || error.message).trim().split('\n')[0])); return; }
      try { resolve(toStatus(JSON.parse(stdout), config.ci[repoKey(entry.repo)]?.ignore)); }
      catch (parseError) { reject(parseError); }
    }));
}

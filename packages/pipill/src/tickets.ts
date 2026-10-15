import { execFile } from 'node:child_process';

export type CiState = 'running' | 'failed' | 'passed';
export type ReviewState = 'merged' | 'attention' | 'approved';
export type TicketPr = {
  number: number; title: string; url: string; branch: string; state: string; isDraft: boolean;
  ci?: CiState; review?: ReviewState; reviewDecision?: string; mergeable?: string;
  failedChecks?: { name: string; url?: string }[];
};
export type TicketStatus = { prs: TicketPr[]; ci?: CiState; review?: ReviewState; error?: string; checkedAt: number };

const CI_RANK: Record<CiState, number> = { failed: 3, running: 2, passed: 1 };
const REVIEW_RANK: Record<ReviewState, number> = { attention: 3, approved: 2, merged: 1 };
export const CI_ICON: Record<CiState, string> = { running: '⏳', failed: '❌', passed: '✅' };
export const REVIEW_ICON: Record<ReviewState, string> = { attention: '❗', approved: '👍', merged: '🔀' };

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
export const checkName = (check: any) => String(check.name ?? check.context ?? '');
/** Ignore entries match a whole check name or its job suffix after ': ' (CircleCI style). */
export function relevantChecks(checks: any[] | undefined, ignore: string[] = []) {
  const ignored = new Set(ignore.map(name => name.toLowerCase()));
  return (checks ?? []).filter(check => {
    const name = checkName(check).toLowerCase();
    return !ignored.has(name) && !ignored.has(name.split(': ').at(-1)!);
  });
}

export function ciState(checks: any[] | undefined): CiState | undefined {
  if (!checks?.length) return undefined;
  const results = checks.map(check => String(check.conclusion ?? check.state ?? '').toUpperCase());
  const statuses = checks.map(check => String(check.status ?? '').toUpperCase());
  if (results.some(r => FAILED.includes(r))) return 'failed';
  if (results.some((r, i) => !r || ['PENDING', 'EXPECTED'].includes(r) || ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'].includes(statuses[i]))) return 'running';
  return 'passed';
}

export function reviewState(pr: any): ReviewState | undefined {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state !== 'OPEN') return undefined;
  if (pr.reviewDecision === 'CHANGES_REQUESTED' || pr.mergeable === 'CONFLICTING') return 'attention';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  return undefined;
}

/** Keeps PRs whose title or branch names the ticket; search hits in bodies or comments are too loose. */
export function matchPrs(ticket: string, raw: any[], ignore: string[] = []): TicketPr[] {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${ticket.replace('-', '[-_]?')}(?![0-9])`, 'i');
  return raw.filter(pr => pattern.test(pr.title ?? '') || pattern.test(pr.headRefName ?? '')).map(pr => {
    const checks = relevantChecks(pr.statusCheckRollup, ignore);
    return {
    number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, state: pr.state, isDraft: !!pr.isDraft,
    reviewDecision: pr.reviewDecision || undefined, mergeable: pr.mergeable || undefined,
    ci: pr.state === 'OPEN' ? ciState(checks) : undefined, review: reviewState(pr),
    failedChecks: checks.filter(check => FAILED.includes(String(check.conclusion ?? check.state ?? '').toUpperCase()))
      .map(check => ({ name: checkName(check), url: check.detailsUrl ?? check.targetUrl })),
  }; }).sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number);
}

/** One CI icon and one review icon summarize every matched PR; merged only shows when nothing is open. */
export function summarize(prs: TicketPr[], checkedAt = Date.now()): TicketStatus {
  const open = prs.filter(pr => pr.state === 'OPEN');
  const pick = <T extends string>(values: (T | undefined)[], rank: Record<T, number>) =>
    values.filter(Boolean).sort((a, b) => rank[b as T] - rank[a as T])[0] as T | undefined;
  if (!open.length) return { prs, review: prs.some(pr => pr.state === 'MERGED') ? 'merged' : undefined, checkedAt };
  return { prs, ci: pick(open.map(pr => pr.ci), CI_RANK), review: pick(open.map(pr => pr.review), REVIEW_RANK), checkedAt };
}

export function icons(status: TicketStatus | undefined) {
  if (!status) return [];
  if (status.review === 'merged') return [REVIEW_ICON.merged];
  return [status.ci && CI_ICON[status.ci], status.review && REVIEW_ICON[status.review]].filter(Boolean) as string[];
}

export function describePr(pr: TicketPr) {
  const state = pr.state === 'OPEN' ? (pr.isDraft ? 'Draft' : 'Open') : pr.state === 'MERGED' ? 'Merged' : 'Closed';
  const ci = pr.ci === 'failed' ? 'CI failed' : pr.ci === 'running' ? 'CI running' : pr.ci === 'passed' ? 'CI passed' : undefined;
  const review = pr.mergeable === 'CONFLICTING' && pr.state === 'OPEN' ? 'Merge conflict'
    : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : pr.reviewDecision === 'APPROVED' ? 'Approved' : undefined;
  return [`#${pr.number} ${state}`, ci, review].filter(Boolean).join(' · ');
}

/** Events worth interrupting for: CI turned red, review needs action, or a PR merged. */
export function notableChanges(ticket: string, before: TicketStatus | undefined, after: TicketStatus) {
  if (!before || before.error) return [];
  const old = new Map(before.prs.map(pr => [pr.number, pr]));
  const messages: string[] = [];
  for (const pr of after.prs) {
    const prev = old.get(pr.number);
    if (!prev) continue;
    if (pr.ci === 'failed' && prev.ci !== 'failed') messages.push(`${ticket} #${pr.number}: CI failed`);
    if (pr.review === 'attention' && prev.review !== 'attention') messages.push(`${ticket} #${pr.number}: ${describePr(pr).split(' · ').at(-1)}`);
    if (pr.state === 'MERGED' && prev.state !== 'MERGED') messages.push(`${ticket} #${pr.number}: merged`);
  }
  return messages;
}

const FIELDS = 'number,title,url,headRefName,state,isDraft,reviewDecision,mergeable,statusCheckRollup';

const run = (file: string, args: string[], cwd: string) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { cwd, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
    error ? reject(new Error((stderr || error.message).trim().split('\n')[0])) : resolve(stdout)));

export async function currentRepo(cwd: string) {
  return (await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd)).trim().toLowerCase();
}

export async function fetchTicketPrs(ticket: string, cwd: string, ignore: string[] = []): Promise<TicketPr[]> {
  return matchPrs(ticket, JSON.parse(await run('gh', ['pr', 'list', '--state', 'all', '--limit', '20', '--search', ticket, '--json', FIELDS], cwd)), ignore);
}

export function currentBranch(cwd: string): Promise<string | undefined> {
  return new Promise(resolve => execFile('git', ['branch', '--show-current'], { cwd, timeout: 5000 },
    (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
}

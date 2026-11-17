import { CI_ICON, REVIEW_TEXT, isDone, type StatusResult } from './github.ts';
import { PRIORITIES, type Entry, type Section } from './queue.ts';

export const TITLE_MAX = 45;
export const SECTION_TITLE: Record<Section, string> = { review: '👀 To review', waiting: '⏳ Waiting' };

/** The chip counts what still needs attention: PRs to review, and PRs waiting on someone else. */
export function chipLabel(entries: Entry[], statuses: Map<string, StatusResult>) {
  const open = entries.filter(entry => !isDone(statuses.get(entry.id)?.status));
  const count = (section: Section) => open.filter(entry => entry.section === section).length;
  return `PRs 👀 ${count('review')} · ⏳ ${count('waiting')}`;
}

export type Grouped = { review: Entry[]; waiting: Entry[]; done: Entry[] };

/** Higher priority first, then oldest first; done PRs leave their section. */
export function group(entries: Entry[], statuses: Map<string, StatusResult>): Grouped {
  const rank = (entry: Entry) => entry.priority ? PRIORITIES.indexOf(entry.priority) : PRIORITIES.length;
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b) || a.addedAt.localeCompare(b.addedAt));
  const done = (entry: Entry) => isDone(statuses.get(entry.id)?.status);
  return {
    review: sorted.filter(entry => !done(entry) && entry.section === 'review'),
    waiting: sorted.filter(entry => !done(entry) && entry.section === 'waiting'),
    done: sorted.filter(done),
  };
}

export const shortRepo = (repo: string) => repo.split('/').at(-1)!;
export const refText = (entry: Entry) => `${shortRepo(entry.repo)} #${entry.number}`;

export function cap(text: string, max = TITLE_MAX) {
  const chars = [...text.trim()];
  if (max < 2) return chars.length ? '…' : '';
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
}

/** Everything after the PR reference on the first line, before the remove button. */
export function statusParts(result: StatusResult | undefined, titleMax = TITLE_MAX): string[] {
  if (!result) return ['Checking…'];
  if (!result.status) return [`⚠ ${cap(result.error ?? 'Status unavailable', titleMax)}`];
  const { status } = result;
  return [cap(status.title, titleMax), ...(status.ci ? [`${CI_ICON[status.ci]} CI`] : []), REVIEW_TEXT[status.review]];
}

export function age(from: string | undefined, now = Date.now()) {
  const start = from ? Date.parse(from) : NaN;
  if (Number.isNaN(start)) return undefined;
  const hours = Math.max(0, (now - start) / 3_600_000);
  return hours < 1 ? '<1h' : hours < 24 ? `${Math.floor(hours)}h` : `${Math.floor(hours / 24)}d`;
}

const day = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? undefined
  : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const titleCase = (text: string) => text[0].toUpperCase() + text.slice(1);

export function detailParts(entry: Entry, result: StatusResult | undefined, now = Date.now()): string[] {
  const status = result?.status;
  const added = [entry.addedBy ? `added by ${entry.addedBy}` : 'added', day(entry.addedAt)].filter(Boolean).join(' ');
  const open = age(status?.createdAt, now);
  return [
    status?.author,
    added || undefined,
    open && `Open since: ${open}`,
    entry.priority && `Priority: ${titleCase(entry.priority)}`,
  ].filter(Boolean) as string[];
}

export function updatedText(checkedAt: number | undefined, now = Date.now()) {
  if (!checkedAt) return 'Not checked yet';
  const minutes = Math.floor((now - checkedAt) / 60_000);
  return minutes < 1 ? 'Updated just now' : `Updated ${minutes} min ago`;
}

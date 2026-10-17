import { describePr, icons, type TicketStatus } from './tickets.ts';

/** Escapes characters that Markdown would otherwise treat as inline formatting in plain text. */
export function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

/** Title and description, which are Markdown by intent. */
export function pillBodyMarkdown(pill: { title?: string; description?: string }) {
  return [pill.title, pill.description].filter(Boolean).join('\n\n');
}

/** Matched PRs as a list with failing checks nested, or the lookup state when there are none. */
export function prListMarkdown(status?: TicketStatus, showRepo = false) {
  if (!status) return '_Checking PRs…_';
  if (status.error && !status.prs.length) return `_PR check failed: ${escapeMarkdown(status.error)}_`;
  if (!status.prs.length) return '_No PR matched._';
  return status.prs.map(pr => {
    const repo = showRepo && pr.repo ? `${escapeMarkdown(pr.repo.split('/')[1])} ` : '';
    const failed = pr.state === 'OPEN' ? pr.failedChecks ?? [] : [];
    return [`- ${repo}${escapeMarkdown(describePr(pr))} · ${pr.url}`,
      ...failed.map(check => `  - ✗ \`${check.name.replace(/`/g, "'")}\`${check.url ? ' · ' + check.url : ''}`)].join('\n');
  }).join('\n');
}

/** The pill's title text with the bar's status icons for tickets. */
export function pillHeading(label: string, ticket?: string, status?: TicketStatus) {
  const marks = ticket ? icons(status) : [];
  return `${label}${marks.length ? ' ' + marks.join('·') : ''}`;
}

/** The whole pill as one Markdown document: heading, body, and PRs for tickets. */
export function pillMarkdown(pill: { label: string; title?: string; description?: string }, ticket?: string,
  status?: TicketStatus, showRepo = false) {
  const parts = [`## ${escapeMarkdown(pillHeading(pill.label, ticket, status))}`, pillBodyMarkdown(pill)];
  if (ticket) parts.push(prListMarkdown(status, showRepo));
  return parts.filter(Boolean).join('\n\n');
}

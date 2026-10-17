import { describePr, icons, type TicketStatus } from './tickets.ts';

/** Escapes characters that Markdown would otherwise treat as formatting in plain labels and status text. */
export function escapeMarkdown(text: string) {
  return text.replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

/**
 * The Markdown shown for one pill in the panel: the label as a heading (with the pill bar's status
 * icons for tickets), the title and description as written, and matched PRs as a list.
 * Titles and descriptions are Markdown by intent; labels and fetched status text are escaped.
 */
export function pillMarkdown(pill: { label: string; title?: string; description?: string }, ticket?: string,
  status?: TicketStatus, showRepo = false) {
  const marks = ticket ? icons(status) : [];
  const parts = [`## ${escapeMarkdown(pill.label)}${marks.length ? ' ' + marks.join('·') : ''}`];
  if (pill.title) parts.push(pill.title);
  if (pill.description) parts.push(pill.description);
  if (ticket) {
    if (!status) parts.push('_Checking PRs…_');
    else if (status.error && !status.prs.length) parts.push(`_PR check failed: ${escapeMarkdown(status.error)}_`);
    else if (!status.prs.length) parts.push('_No PR matched._');
    else parts.push(status.prs.map(pr => {
      const repo = showRepo && pr.repo ? `${escapeMarkdown(pr.repo.split('/')[1])} ` : '';
      const failed = pr.state === 'OPEN' ? pr.failedChecks ?? [] : [];
      return [`- ${repo}${escapeMarkdown(describePr(pr))} · ${pr.url}`,
        ...failed.map(check => `  - ✗ \`${check.name.replace(/`/g, "'")}\`${check.url ? ' · ' + check.url : ''}`)].join('\n');
    }).join('\n'));
  }
  return parts.join('\n\n');
}

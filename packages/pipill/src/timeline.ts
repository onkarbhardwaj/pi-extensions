import { spawn, type ChildProcess } from 'node:child_process';
import type { TimelineConfig } from './config.ts';

export const TIMELINE_STATE_TYPE = 'pi-pill-timeline';
/** Updates per label, oldest first, plus the last session entry already summarized. */
export type TimelineState = { cursor?: string; timelines: Record<string, string[]> };
export type Excerpt = { role: 'user' | 'assistant'; text: string };

const MESSAGE_CHARS = 2000, TOTAL_CHARS = 40_000, HISTORY = 3, UPDATE_CHARS = 120, MAX_UPDATES = 200;

export function restoreTimeline(entries: any[]): TimelineState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== TIMELINE_STATE_TYPE) continue;
    const data = entry.data;
    if (data?.version !== 1 || !data.timelines || typeof data.timelines !== 'object') return { timelines: {} };
    const timelines: Record<string, string[]> = {};
    for (const [label, updates] of Object.entries(data.timelines))
      if (Array.isArray(updates)) timelines[label] = updates.filter((u): u is string => typeof u === 'string');
    return { cursor: typeof data.cursor === 'string' ? data.cursor : undefined, timelines };
  }
  return { timelines: {} };
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n');
}

/**
 * User and assistant text after `cursor` on the active branch; tool calls, tool results, and hidden
 * reminders are skipped. If the cursor is not on this branch (after tree navigation), the whole
 * branch counts as new and the newest text is kept within the size limit.
 */
export function newMessages(branch: any[], cursor?: string) {
  const start = cursor ? branch.findIndex(entry => entry?.id === cursor) + 1 : 0;
  const excerpts: (Excerpt & { id: string })[] = [];
  for (const entry of branch.slice(start)) {
    const role = entry?.type === 'message' ? entry.message?.role : undefined;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = messageText(entry.message).trim();
    if (text) excerpts.push({ role, text: text.length > MESSAGE_CHARS ? text.slice(0, MESSAGE_CHARS) + ' …' : text, id: entry.id });
  }
  let total = 0, first = excerpts.length;
  while (first > 0 && total + excerpts[first - 1].text.length <= TOTAL_CHARS) total += excerpts[--first].text.length;
  return { messages: excerpts.slice(first).map(({ role, text }) => ({ role, text })), count: excerpts.length, lastId: excerpts.at(-1)?.id };
}

export const SYSTEM_PROMPT = `You keep a timeline of short updates for each tracked topic or ticket in a work conversation.
Return only a JSON object. Its keys are exactly the given pill labels. Each value is a new update string, or null.
Write an update when the new messages concern that pill's subject and move it forward: a decision, a result, a change of plan, a blocker, or a next step. Use the label, title, description, and earlier updates to judge what the pill covers.
Use null when the new messages do not concern that pill, or only repeat what earlier updates already say.
An update reads like a commit message: one to three terse fragments, each ending with a period, at most 120 characters in total.
Use past-tense verbs. Skip conjunctions, reasons, procedure, counts, identifiers, and branch names. The conversation holds the detail.
Good: "Shortened timeline updates to headlines. Merged +/- toggle."
Good: "Fixed timeline trigger. Refresh works again."
Bad: "Timeline output is now limited to a short headline of one or two sentences, about 200 characters, to stop Haiku from overreaching. The change is committed on a branch."
Do not use semicolons. Do not use filler, hedging, or praise. Do not repeat earlier updates.
Read the pill's earlier updates and continue from them, so the timeline reads smoothly. Only sound abrupt when the work actually changed direction.`;

export function buildInput(pills: { label: string; title?: string; description?: string }[], state: TimelineState, messages: Excerpt[]) {
  return JSON.stringify({
    pills: pills.map(pill => ({ label: pill.label, title: pill.title, description: pill.description,
      earlierUpdates: (state.timelines[pill.label] ?? []).slice(-HISTORY) })),
    newMessages: messages,
  });
}

/** Keeps whole sentences within the limit; falls back to a word boundary, never cutting mid-word. */
export function shorten(text: string, limit = UPDATE_CHARS) {
  if (text.length <= limit) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let kept = '';
  for (const sentence of sentences) {
    if ((kept + sentence).trim().length > limit) break;
    kept += sentence;
  }
  if (kept.trim()) return kept.trim();
  const cut = text.slice(0, limit - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trimEnd() + '…';
}

/** Accepts only string updates for known labels; anything malformed is rejected as a whole. */
export function parseUpdates(output: string, labels: string[]): Record<string, string> {
  const start = output.indexOf('{'), end = output.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Summarizer returned no JSON.');
  let value: unknown;
  try { value = JSON.parse(output.slice(start, end + 1)); } catch { throw new Error('Summarizer returned invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Summarizer returned no JSON object.');
  const updates: Record<string, string> = {};
  for (const label of labels) {
    const update = (value as Record<string, unknown>)[label];
    if (typeof update !== 'string') continue;
    const clean = update.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean) updates[label] = shorten(clean);
  }
  return updates;
}

export function applyUpdates(state: TimelineState, updates: Record<string, string>, cursor?: string): TimelineState {
  const timelines = { ...state.timelines };
  for (const [label, update] of Object.entries(updates)) timelines[label] = [...(timelines[label] ?? []), update].slice(-MAX_UPDATES);
  return { cursor: cursor ?? state.cursor, timelines };
}

/** Retry delay after consecutive failures: 2, 4, 8 … minutes, at most 30. */
export const backoffMs = (failures: number) => failures ? Math.min(30, 2 ** failures) * 60_000 : 0;

/**
 * Runs a session-less, tool-less, extension-less Pi with the input on stdin.
 * Resolves with stdout; rejects on spawn failure, non-zero exit, or timeout. Never throws synchronously.
 */
export function runSummarizer(input: string, config: TimelineConfig, track?: (child: ChildProcess | undefined) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('pi', ['-p', '--no-session', '-ne', '--no-mcp', '-nt', '-ns', '-nc', '-np', '--thinking', 'off',
        '--provider', config.provider, '--model', config.model, '--system-prompt', SYSTEM_PROMPT, 'Write the updates now.'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    track?.(child);
    let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); track?.(undefined);
      if (error) reject(error); else resolve(stdout);
    };
    const timer = setTimeout(() => {
      // Close our ends of the pipes too, so a grandchild holding them cannot keep anything alive.
      try { child.kill('SIGKILL'); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); } catch {}
      finish(new Error(`model timed out after ${config.timeoutSeconds} s`));
    }, config.timeoutSeconds * 1000);
    child.stdout?.on('data', chunk => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < 10_000) stderr += chunk; });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? undefined : new Error((stderr.trim().split('\n').at(-1) || `pi exited with ${code}`).slice(0, 200))));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

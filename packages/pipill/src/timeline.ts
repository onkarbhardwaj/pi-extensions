import { spawn, type ChildProcess } from 'node:child_process';
import type { TimelineConfig } from './config.ts';

export const TIMELINE_STATE_TYPE = 'pi-pill-timeline';
/** A summarized step of recent work, tagged with the topic it belongs to (null for chatter). */
export type RecentEntry = { text: string; topic: string | null };
/**
 * Updates per label (oldest first), recent work across all subjects (oldest first), suggestion
 * labels the user dismissed, and the last session entry already summarized.
 */
export type TimelineState = { cursor?: string; timelines: Record<string, string[]>; recent: RecentEntry[]; dismissed: string[] };
export type Excerpt = { role: 'user' | 'assistant'; text: string };

const MESSAGE_CHARS = 2000, TOTAL_CHARS = 40_000, HISTORY = 3, UPDATE_CHARS = 120, MAX_UPDATES = 200;
/** Recent entries kept for suggestions and backfill; the panel shows only the newest few. */
export const RECENT_KEPT = 30, RECENT_SHOWN = 5, SUGGESTIONS_SHOWN = 3;
const TOPIC_CHARS = 80;

const emptyState = (): TimelineState => ({ timelines: {}, recent: [], dismissed: [] });
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function restoreTimeline(entries: any[]): TimelineState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== TIMELINE_STATE_TYPE) continue;
    const data = entry.data;
    if (data?.version !== 1 || !data.timelines || typeof data.timelines !== 'object') return emptyState();
    const timelines: Record<string, string[]> = {};
    for (const [label, updates] of Object.entries(data.timelines)) if (Array.isArray(updates)) timelines[label] = strings(updates);
    const recent = Array.isArray(data.recent) ? data.recent.filter((r: any) => typeof r?.text === 'string'
      && (r.topic === null || typeof r.topic === 'string')).map((r: any) => ({ text: r.text, topic: r.topic })) : [];
    return { ...(typeof data.cursor === 'string' ? { cursor: data.cursor } : {}), timelines, recent, dismissed: strings(data.dismissed) };
  }
  return emptyState();
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

export const SYSTEM_PROMPT = `You keep short timelines for a work conversation between a user and an AI assistant.
Return only a JSON object with two keys:
"updates": an object whose keys are exactly the given pill labels. Each value is an update string for that pill, or null.
"recent": an array of zero to three entries, each {"text": string, "topic": string or null}.

Every update and recent text reads like a commit message: one to three terse fragments, each ending with a period, at most 120 characters in total. Use past-tense verbs. Never use semicolons. Start a new fragment instead.
Good: "Venue fell through. Need a replacement."
Bad: "Venue fell through; need a replacement."
Keep numbers that are the result. Leave out numbers and names that only describe the work.
Good: "Switched quicksort to median-of-three pivots. 1M-item sort now 0.4s."
Good: "Switched index to cosine. Recall back to 0.83."
Good: "Grouped quarter's work for self review."
Bad: "Reviewed 23 PRs and 11 tickets across 3 groups."
Good: "Rebalanced December on-call."
Bad: "Rebalanced December on-call. Sam and Lee swapped weeks 2 and 4. Arun moved to January."

updates: write one only when the new messages move that pill's subject forward: a decision, a result, a change of plan, a blocker, or a next step. Judge what a pill covers from its label, title, description, and earlier updates. Otherwise null. Do not repeat earlier updates. Continue from earlier updates so the timeline reads smoothly.

recent: what moved forward in the new messages, across all subjects. Skip small talk.
Cover every subject that moved forward before giving any subject a second entry. Example: if the messages speed up a quicksort and also report that an offsite venue fell through, write one entry for each, not two for the quicksort.
recent.topic: the subject the entry belongs to. Every entry about real work gets a topic. Choose in this order:
1. An existing pill label that covers the subject.
2. A label from knownTopics for the same subject. Reuse it exactly.
3. A new short label of two to four words that names the subject. Example: messages about rebalancing the on-call schedule, with no matching pill or known topic, get topic "on-call rotation".
When work belongs to a ticket, use the ticket's label, even if the message only mentions the fix.
Example (MARG is a hypothetical ticket prefix used only for illustration): knownTopics has "MARG-1042 quicksort slowdown". New messages say "the pivot selection PR got approved, merging". Use topic "MARG-1042 quicksort slowdown", not "pivot selection".
If a new subject names a ticket ID such as MARG-2207, start the label with it: "MARG-2207 search regression".
The MARG labels above are illustrations only. Never output a MARG label or invent a ticket ID. Use a ticket ID only when it appears in the pills, knownTopics, or new messages.
Use null only for small talk or a quick question with no outcome, such as explaining an API difference.`;

/** Topic labels already in use, newest first, so the summarizer reuses them for the same subject. */
export function knownTopics(state: TimelineState) {
  return [...new Set(state.recent.map(entry => entry.topic).filter((t): t is string => !!t).reverse())];
}

export function buildInput(pills: { label: string; title?: string; description?: string }[], state: TimelineState, messages: Excerpt[]) {
  return JSON.stringify({
    pills: pills.map(pill => ({ label: pill.label, title: pill.title, description: pill.description,
      earlierUpdates: (state.timelines[pill.label] ?? []).slice(-HISTORY) })),
    knownTopics: knownTopics(state),
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

const cleanText = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';

/**
 * Parses the summarizer's JSON. Unknown pill labels, non-strings, and malformed recent entries are
 * dropped; output that is not a JSON object is rejected as a whole.
 */
export function parseOutput(output: string, labels: string[]): { updates: Record<string, string>; recent: RecentEntry[] } {
  const start = output.indexOf('{'), end = output.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Summarizer returned no JSON.');
  let value: any;
  try { value = JSON.parse(output.slice(start, end + 1)); } catch { throw new Error('Summarizer returned invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Summarizer returned no JSON object.');
  const updates: Record<string, string> = {};
  const rawUpdates = value.updates && typeof value.updates === 'object' ? value.updates : {};
  for (const label of labels) {
    const clean = cleanText(rawUpdates[label]);
    if (clean) updates[label] = shorten(clean);
  }
  const recent: RecentEntry[] = (Array.isArray(value.recent) ? value.recent : []).slice(0, 3).flatMap((entry: any) => {
    const text = cleanText(entry?.text);
    const topic = cleanText(entry?.topic).slice(0, TOPIC_CHARS) || null;
    return text ? [{ text: shorten(text), topic }] : [];
  });
  return { updates, recent };
}

export function applyUpdates(state: TimelineState, updates: Record<string, string>, recent: RecentEntry[] = [], cursor?: string): TimelineState {
  const timelines = { ...state.timelines };
  for (const [label, update] of Object.entries(updates)) timelines[label] = [...(timelines[label] ?? []), update].slice(-MAX_UPDATES);
  return { ...state, cursor: cursor ?? state.cursor, timelines, recent: [...state.recent, ...recent].slice(-RECENT_KEPT) };
}

/**
 * Topics worth offering as new pills: tags on recent entries, newest first, without duplicates,
 * labels or ticket IDs that already have a pill, or dismissed labels.
 */
export function suggestions(state: TimelineState, pillLabels: string[], ticketOf: (label: string) => string | undefined) {
  const key = (label: string) => ticketOf(label) ?? label.toLowerCase();
  const taken = new Set([...pillLabels.map(key), ...state.dismissed.map(key)]);
  const result: string[] = [];
  for (const topic of knownTopics(state)) {
    if (taken.has(key(topic))) continue;
    taken.add(key(topic));
    result.push(topic);
    if (result.length === SUGGESTIONS_SHOWN) break;
  }
  return result;
}

/** Starts a new pill's timeline from the recent entries tagged with its label, oldest first. */
export function adoptTopic(state: TimelineState, label: string, ticketOf: (label: string) => string | undefined): TimelineState {
  const key = (value: string) => ticketOf(value) ?? value.toLowerCase();
  const tagged = state.recent.filter(entry => entry.topic && key(entry.topic) === key(label)).map(entry => entry.text);
  return { ...state, timelines: { ...state.timelines, [label]: [...(state.timelines[label] ?? []), ...tagged].slice(-MAX_UPDATES) } };
}

export function dismissTopic(state: TimelineState, label: string): TimelineState {
  return { ...state, dismissed: [...new Set([...state.dismissed, label])].slice(-100) };
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

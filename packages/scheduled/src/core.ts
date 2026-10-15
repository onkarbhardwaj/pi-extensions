export const STATE_TYPE = 'pi-reminders-state';
export type ReminderStatus = 'scheduled' | 'due' | 'missed';
export type Reminder = { id: string; text: string; dueAt: number; createdAt: number; status: ReminderStatus };

const MINUTE = 60_000;
const UNIT: Record<string, number> = { m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE,
  d: 24 * 60 * MINUTE, day: 24 * 60 * MINUTE, days: 24 * 60 * MINUTE };

export function parseWhen(input: string, now = Date.now()): number {
  const text = input.trim().replace(/^in\s+/i, '');
  const relative = text.match(/^(\d+)\s*([a-z]+)$/i);
  if (relative) {
    const unit = UNIT[relative[2].toLowerCase()];
    if (!unit || Number(relative[1]) <= 0) throw new Error('Use a positive duration such as 30m, 2h or 1d.');
    return now + Number(relative[1]) * unit;
  }
  const clock = text.replace(/^at\s+/i, '').match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const [hours, minutes] = clock.slice(1).map(Number);
    if (hours > 23 || minutes > 59) throw new Error('Invalid time.');
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const absolute = Date.parse(text.replace(/^at\s+/i, ''));
  if (Number.isFinite(absolute) && absolute > now) return absolute;
  throw new Error('Use 30m, 2h, 1d, 15:30, or a future ISO date.');
}

export function parseRemind(args: string, now = Date.now()) {
  const match = args.trim().match(/^((?:in\s+)?\d+\s*[a-z]+|(?:at\s+)?\d{1,2}:\d{2}|(?:at\s+)?\S+)\s+(.+)$/i);
  if (!match) throw new Error('Usage: /remind <30m|2h|15:30|ISO date> <reminder>');
  let text = match[2].trim();
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  return { dueAt: parseWhen(match[1], now), text: validateText(text) };
}

export function validateText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Reminder text is required.');
  if (text.length > 500) throw new Error('Reminder text is limited to 500 characters.');
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('Reminder text cannot contain control characters.');
  return text.trim();
}

export function restore(entries: any[]): Reminder[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom' || entry.customType !== STATE_TYPE) continue;
    const data = entry.data;
    if (data?.version !== 1 || !Array.isArray(data.reminders)) throw new Error('Unsupported saved reminder state.');
    const ids = new Set<string>();
    return data.reminders.map((reminder: any) => {
      if (!reminder || typeof reminder.id !== 'string' || ids.has(reminder.id)
        || !Number.isFinite(reminder.dueAt) || !Number.isFinite(reminder.createdAt)
        || !['scheduled', 'due', 'missed'].includes(reminder.status)) throw new Error('Malformed saved reminder state.');
      ids.add(reminder.id);
      return { ...reminder, text: validateText(reminder.text) };
    });
  }
  return [];
}

export function markMissed(reminders: Reminder[], now = Date.now()) {
  return reminders.map(reminder => reminder.status === 'scheduled' && reminder.dueAt <= now ? { ...reminder, status: 'missed' as const } : reminder);
}

export function markDue(reminders: Reminder[], now = Date.now()) {
  return reminders.map(reminder => reminder.status === 'scheduled' && reminder.dueAt <= now ? { ...reminder, status: 'due' as const } : reminder);
}

export function nextDue(reminders: Reminder[]) {
  return reminders.filter(reminder => reminder.status === 'scheduled').reduce((min, reminder) => Math.min(min, reminder.dueAt), Infinity);
}

export function statusText(reminders: Reminder[]) {
  const attention = reminders.filter(reminder => reminder.status !== 'scheduled').length;
  if (attention) return `⏰ ${attention} due`;
  const next = nextDue(reminders);
  if (!Number.isFinite(next)) return undefined;
  return `⏰ ${reminders.length} scheduled · next ${new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function describe(reminder: Reminder) {
  const prefix = reminder.status === 'scheduled' ? 'Scheduled' : reminder.status === 'due' ? 'Due' : 'Missed';
  return `${prefix} · ${new Date(reminder.dueAt).toLocaleString()} · ${reminder.text}`;
}

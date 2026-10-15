import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Reminder } from './core.ts';

export const MEETINGS_STATE_TYPE = 'pi-busywork-meetings';
export type MeetingStatus = 'accepted' | 'tentative' | 'declined' | 'invited' | 'organizer' | 'own' | 'unknown';
export type Meeting = { id: string; title: string; start: string; end: string; status: MeetingStatus; canceled: boolean };
export type MeetingsConfig = { enabled: boolean; command?: string; leadMinutes: number; intervalMinutes: number; statuses: MeetingStatus[] };

const STATUSES: MeetingStatus[] = ['accepted', 'tentative', 'declined', 'invited', 'organizer', 'own', 'unknown'];
export const DEFAULT_MEETINGS: MeetingsConfig = { enabled: true, leadMinutes: 5, intervalMinutes: 15, statuses: ['accepted', 'tentative', 'organizer', 'invited', 'unknown'] };
export const DEFAULT_COMMAND = fileURLToPath(new URL('../helpers/bin/meetings', import.meta.url));

export function parseMeetingsConfig(value: unknown): MeetingsConfig {
  if (value === undefined) return { ...DEFAULT_MEETINGS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('meetings must be an object.');
  const raw = value as Record<string, unknown>;
  const config = { ...DEFAULT_MEETINGS };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error('meetings.enabled must be true or false.');
    config.enabled = raw.enabled;
  }
  if (raw.command !== undefined) {
    if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error('meetings.command must be a path.');
    config.command = raw.command;
  }
  for (const key of ['leadMinutes', 'intervalMinutes'] as const) {
    const number = raw[key];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 0 || number > 1440) throw new Error(`meetings.${key} must be whole minutes.`);
    config[key] = number;
  }
  if (config.intervalMinutes < 5) throw new Error('meetings.intervalMinutes must be at least 5.');
  if (raw.statuses !== undefined) {
    if (!Array.isArray(raw.statuses) || raw.statuses.some(status => !STATUSES.includes(status))) throw new Error(`meetings.statuses must use ${STATUSES.join(', ')}.`);
    config.statuses = raw.statuses as MeetingStatus[];
  }
  return config;
}

export async function loadBusyworkConfig(path: string): Promise<{ meetings: MeetingsConfig }> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { meetings: { ...DEFAULT_MEETINGS } };
    throw error;
  }
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Busywork config must be a JSON object.');
  return { meetings: parseMeetingsConfig(value.meetings) };
}

export function parseMeetings(stdout: string): Meeting[] {
  const value = JSON.parse(stdout);
  if (!Array.isArray(value)) throw new Error('Meetings helper must print a JSON array.');
  return value.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string'
    && Number.isFinite(Date.parse(item.start)) && STATUSES.includes(item.status) && typeof item.canceled === 'boolean');
}

export function runMeetings(command: string): Promise<Meeting[]> {
  return new Promise((resolve, reject) => execFile(command, ['today', '--json'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim().split('\n')[0]));
      try { resolve(parseMeetings(stdout)); } catch (e) { reject(e); }
    }));
}

export async function commandExists(command: string) {
  try { await access(command); return true; } catch { return false; }
}

export function restoreDismissed(entries: any[]): string[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom' || entry.customType !== MEETINGS_STATE_TYPE) continue;
    const dismissed = entry.data?.version === 1 ? entry.data.dismissed : undefined;
    return Array.isArray(dismissed) ? dismissed.filter((id: unknown) => typeof id === 'string') : [];
  }
  return [];
}

/** Meeting IDs end with `@<ISO start>`; drop records for meetings that started over a day ago. */
export function pruneDismissed(dismissed: string[], now = Date.now()) {
  return dismissed.filter(id => {
    const start = Date.parse(id.slice(id.lastIndexOf('@') + 1));
    return !Number.isFinite(start) || start > now - 86_400_000;
  });
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Adds a reminder for each upcoming eligible meeting and removes still-scheduled reminders
 * for today's meetings that were cancelled, declined, moved, or deleted. A moved meeting has a
 * new ID, so its old reminder is removed and a new one added. Existing reminders are never
 * edited, which keeps snoozes intact; dismissed meetings are never re-added.
 */
export function syncMeetings(reminders: Reminder[], meetings: Meeting[], dismissed: string[], config: MeetingsConfig,
  newId: () => string, now = Date.now()) {
  const eligible = meetings.filter(meeting => !meeting.canceled && config.statuses.includes(meeting.status) && Date.parse(meeting.start) > now);
  const wanted = new Set(eligible.map(meeting => meeting.id));
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = dayStart.getTime() + 86_400_000;
  const sourceStart = (id: string) => Date.parse(id.slice(id.lastIndexOf('@') + 1));
  const kept = reminders.filter(reminder => {
    if (!reminder.source || reminder.status !== 'scheduled') return true;
    const start = sourceStart(reminder.source);
    const today = start >= dayStart.getTime() && start < dayEnd;
    return !today || start <= now || wanted.has(reminder.source);
  });
  const known = new Set([...kept.map(reminder => reminder.source).filter(Boolean), ...dismissed]);
  const added: Reminder[] = eligible.filter(meeting => !known.has(meeting.id)).map(meeting => {
    const start = Date.parse(meeting.start);
    const title = meeting.title.replace(/[\x00-\x1f\x7f]+/g, ' ').trim() || 'Meeting';
    const reply = meeting.status === 'invited' ? ' (no reply)' : '';
    return { id: newId(), text: `📅 ${title} at ${clock(start)}${reply}`.slice(0, 500),
      dueAt: Math.max(start - config.leadMinutes * 60_000, now + 1000), createdAt: now, status: 'scheduled', source: meeting.id };
  });
  const next = [...kept, ...added].sort((a, b) => a.dueAt - b.dueAt);
  const changed = added.length > 0 || kept.length !== reminders.length;
  return { reminders: next, changed, added: added.length, removed: reminders.length - kept.length };
}

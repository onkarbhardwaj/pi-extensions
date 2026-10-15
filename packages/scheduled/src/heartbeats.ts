import { parseWhen } from './core.ts';

export const HEARTBEAT_STATE_TYPE = 'pi-heartbeats-state';
export type HeartbeatStatus = 'active' | 'paused' | 'expired';
export type Heartbeat = {
  id: string; name: string; prompt: string; intervalMs: number; nextAt: number; createdAt: number;
  expiresAt?: number; status: HeartbeatStatus; runs: number; lastRunAt?: number; lastResult?: string;
};

const MIN_INTERVAL = 60_000;

export function parseInterval(input: string): number {
  if (!/^(?:every\s+)?\d+\s*[a-z]+$/i.test(input.trim())) throw new Error('Use an interval such as 5m, 1h or 1d.');
  const value = parseWhen(input.trim().replace(/^every\s+/i, ''), 0);
  if (value < MIN_INTERVAL) throw new Error('Heartbeat interval must be at least 1 minute.');
  return value;
}

export function validateName(name: unknown) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(name)) throw new Error('Heartbeat name must be 1-48 letters, numbers, dots, dashes or underscores.');
  return name;
}

export function validatePrompt(prompt: unknown) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Heartbeat instruction is required.');
  if (prompt.length > 2000) throw new Error('Heartbeat instruction is limited to 2000 characters.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) throw new Error('Heartbeat instruction cannot contain control characters.');
  return prompt.trim();
}

/** Parses `/heartbeat <interval> [until <time|duration>] <name> <instruction>`. */
export function parseHeartbeat(args: string, now = Date.now()) {
  const match = args.trim().match(/^((?:every\s+)?\d+\s*[a-z]+)\s+(?:until\s+(\S+)\s+)?(\S+)\s+([\s\S]+)$/i);
  if (!match) throw new Error('Usage: /heartbeat <5m|1h> [until <11:30|2h>] <name> <instruction>');
  const intervalMs = parseInterval(match[1]);
  const expiresAt = match[2] ? parseWhen(match[2], now) : undefined;
  return { intervalMs, expiresAt, name: validateName(match[3]), prompt: validatePrompt(match[4]) };
}

export function restoreHeartbeats(entries: any[]): Heartbeat[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom' || entry.customType !== HEARTBEAT_STATE_TYPE) continue;
    const data = entry.data;
    if (data?.version !== 1 || !Array.isArray(data.heartbeats)) throw new Error('Unsupported saved heartbeat state.');
    const ids = new Set<string>(), names = new Set<string>();
    return data.heartbeats.map((beat: any) => {
      if (!beat || typeof beat.id !== 'string' || ids.has(beat.id) || names.has(beat.name)
        || !Number.isFinite(beat.intervalMs) || beat.intervalMs < MIN_INTERVAL || !Number.isFinite(beat.nextAt)
        || !Number.isFinite(beat.createdAt) || !Number.isInteger(beat.runs) || beat.runs < 0
        || (beat.expiresAt !== undefined && !Number.isFinite(beat.expiresAt))
        || !['active', 'paused', 'expired'].includes(beat.status)) throw new Error('Malformed saved heartbeat state.');
      ids.add(beat.id); names.add(beat.name);
      return { ...beat, name: validateName(beat.name), prompt: validatePrompt(beat.prompt) };
    });
  }
  return [];
}

export function expire(heartbeats: Heartbeat[], now = Date.now()) {
  return heartbeats.map(beat => beat.status !== 'expired' && beat.expiresAt !== undefined && beat.expiresAt <= now ? { ...beat, status: 'expired' as const } : beat);
}

/** The first active heartbeat whose time has come; missed beats coalesce into one run. */
export function dueHeartbeat(heartbeats: Heartbeat[], now = Date.now()) {
  return heartbeats.filter(beat => beat.status === 'active' && beat.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt)[0];
}

export function markRun(beat: Heartbeat, now = Date.now()): Heartbeat {
  return { ...beat, runs: beat.runs + 1, lastRunAt: now, nextAt: now + beat.intervalMs };
}

export function nextHeartbeat(heartbeats: Heartbeat[]) {
  return heartbeats.filter(beat => beat.status === 'active').reduce((min, beat) => Math.min(min, beat.nextAt, beat.expiresAt ?? Infinity), Infinity);
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const span = (ms: number) => ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.round(ms / 60_000)}m`;

export function heartbeatStatusText(heartbeats: Heartbeat[]) {
  const active = heartbeats.filter(beat => beat.status === 'active');
  if (!active.length) return heartbeats.length ? `♥ ${heartbeats.length} paused` : undefined;
  return `♥ ${active.length} active · next ${time(Math.min(...active.map(beat => beat.nextAt)))}`;
}

export function heartbeatSummary(beat: Heartbeat) {
  const parts = [beat.status === 'active' ? 'Active' : beat.status === 'paused' ? 'Paused' : 'Expired', `every ${span(beat.intervalMs)}`];
  if (beat.status === 'active') parts.push(`next ${time(beat.nextAt)}`);
  else if (beat.lastRunAt) parts.push(`last ran ${time(beat.lastRunAt)}`);
  parts.push(`ran ${beat.runs} time${beat.runs === 1 ? '' : 's'}`);
  if (beat.expiresAt !== undefined && beat.status !== 'expired') parts.push(`expires ${time(beat.expiresAt)}`);
  return parts.join(' · ');
}

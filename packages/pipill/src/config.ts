import { readFile } from 'node:fs/promises';

export type CiConfig = { ignore: string[] };
/** Background per-pill summaries. Off unless configured, since each run is a model call. */
export type TimelineConfig = { enabled: boolean; provider: string; model: string; minMessages: number; timeoutSeconds: number };
export type PipillConfig = { ticketPrefixes: string[]; repos: string[]; ci: Record<string, CiConfig>; timeline: TimelineConfig };

export const DEFAULT_TIMELINE: TimelineConfig = { enabled: false, provider: 'github-copilot', model: 'claude-haiku-5.5', minMessages: 6, timeoutSeconds: 20 };

function parseTimeline(value: unknown): TimelineConfig {
  if (value === undefined) return { ...DEFAULT_TIMELINE };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('timeline must be an object.');
  const raw = value as Record<string, unknown>, config = { ...DEFAULT_TIMELINE };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new Error('timeline.enabled must be true or false.');
    config.enabled = raw.enabled;
  }
  for (const key of ['provider', 'model'] as const) {
    const text = raw[key];
    if (text === undefined) continue;
    if (typeof text !== 'string' || !/^[\w.:/-]+$/.test(text)) throw new Error(`timeline.${key} must be a provider or model name.`);
    config[key] = text;
  }
  for (const [key, min, max] of [['minMessages', 2, 200], ['timeoutSeconds', 5, 300]] as const) {
    const number = raw[key];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) throw new Error(`timeline.${key} must be a whole number from ${min} to ${max}.`);
    config[key] = number;
  }
  return config;
}

function parseCi(value: unknown): Record<string, CiConfig> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ci must map owner/repo names to CI settings.');
  const result: Record<string, CiConfig> = {};
  for (const [repo, raw] of Object.entries(value)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`ci key ${repo} must be owner/repo.`);
    const ignore = (raw as any)?.ignore ?? [];
    if (!Array.isArray(ignore) || ignore.some(name => typeof name !== 'string' || !name.trim()))
      throw new Error(`ci.${repo}.ignore must be an array of check names.`);
    result[repo.toLowerCase()] = { ignore };
  }
  return result;
}

export function parseConfig(value: unknown): PipillConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pipill config must be a JSON object.');
  }
  const prefixes = (value as { ticketPrefixes?: unknown }).ticketPrefixes ?? [];
  if (!Array.isArray(prefixes) || prefixes.some(prefix =>
    typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix))) {
    throw new Error('ticketPrefixes must contain project keys without hyphens, such as PROJ.');
  }
  const repos = (value as any).repos ?? [];
  if (!Array.isArray(repos) || repos.some(repo => typeof repo !== 'string' || !/^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/.test(repo)))
    throw new Error('repos must contain owner/repo or host/owner/repo names.');
  return { ticketPrefixes: [...new Set(prefixes.map(prefix => prefix.toUpperCase()))], repos, ci: parseCi((value as any).ci),
    timeline: parseTimeline((value as any).timeline) };
}

export async function loadConfig(path: string): Promise<PipillConfig> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ticketPrefixes: [], repos: [], ci: {}, timeline: { ...DEFAULT_TIMELINE } };
    throw error;
  }
  return parseConfig(JSON.parse(source));
}

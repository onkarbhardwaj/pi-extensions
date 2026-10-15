import { readFile } from 'node:fs/promises';

export type CiConfig = { ignore: string[] };
export type PipillConfig = { ticketPrefixes: string[]; ci: Record<string, CiConfig> };

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
  return { ticketPrefixes: [...new Set(prefixes.map(prefix => prefix.toUpperCase()))], ci: parseCi((value as any).ci) };
}

export async function loadConfig(path: string): Promise<PipillConfig> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ticketPrefixes: [], ci: {} };
    throw error;
  }
  return parseConfig(JSON.parse(source));
}

import { readFile } from 'node:fs/promises';

export function parseConfig(value: unknown): { ticketPrefixes: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pipill config must be a JSON object.');
  }
  const prefixes = (value as { ticketPrefixes?: unknown }).ticketPrefixes ?? [];
  if (!Array.isArray(prefixes) || prefixes.some(prefix =>
    typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix))) {
    throw new Error('ticketPrefixes must contain project keys without hyphens, such as PROJ.');
  }
  return { ticketPrefixes: [...new Set(prefixes.map(prefix => prefix.toUpperCase()))] };
}

export async function loadConfig(path: string): Promise<{ ticketPrefixes: string[] }> {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ticketPrefixes: [] };
    throw error;
  }
  return parseConfig(JSON.parse(source));
}

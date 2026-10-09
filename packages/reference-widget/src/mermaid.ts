import { render } from 'grok-mermaid';

// Called for fenced Mermaid blocks by Pi's public Markdown transform hook.
export function diagramMarkdown(source: string, original: string, width: number): string {
  const art = render(source);
  if (!art || art.width > width || art.warnings.length) return original;
  return art.plain.map(line => {
    const text = line || '\u00a0';
    const fence = '`'.repeat(Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length)) + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  }).join('  \n') + '\n';
}

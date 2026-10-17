import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Marked } from '@earendil-works/pi-tui';
import { safeText } from './core.ts';
import { diagramMarkdown } from './mermaid.ts';

const parser = new Marked();

/** Pi's themed Markdown renderer, with fenced Mermaid blocks drawn as diagrams. Shared by the reader and /md. */
export function markdownView(text: string) {
  return new Markdown(safeText(text.replace(/\r\n/g, '\n')), 0, 0, getMarkdownTheme(), undefined, {
    transform: (source, columns) => parser.lexer(source).map(token => token.type === 'code' && token.lang?.trim().toLowerCase() === 'mermaid'
      ? diagramMarkdown(token.text, token.raw, columns) : token.raw).join(''),
  });
}

/**
 * A preview pane that renders only when its text or width changes, and positions itself
 * by document progress so frequent refreshes do not make it jump.
 */
export class MarkdownPreview {
  private view: Markdown | undefined;
  private text: string | undefined;
  private width = 0;
  private lines: string[] = [];

  setText(text: string) {
    if (text === this.text) return;
    this.text = text;
    this.view = markdownView(text);
    this.width = 0;
  }

  invalidate() { this.view?.invalidate(); this.width = 0; }

  render(width: number, height: number, progress: number): string[] {
    if (this.view && width !== this.width) { this.lines = this.view.render(width); this.width = width; }
    const top = Math.round(Math.max(0, Math.min(1, progress)) * Math.max(0, this.lines.length - height));
    const visible = this.lines.slice(top, top + height);
    while (visible.length < height) visible.push('');
    return visible;
  }
}

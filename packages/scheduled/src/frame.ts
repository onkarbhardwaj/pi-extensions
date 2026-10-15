import { rgbColor, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

// A visual frame only: preserve child focus and translate its mouse coordinates.
export function frame(child: any, theme: any): Component & { focused?: boolean; dispose?(): void } {
  let width = 0, height = 0;
  return {
    get focused() { return child.focused; },
    set focused(value) { child.focused = value; },
    invalidate() { child.invalidate(); },
    dispose() { child.dispose?.(); },
    handleInput(data) { child.handleInput?.(data); },
    handleMouse(event) {
      if (width < 3) return child.handleMouse?.(event);
      if (event.type !== 'drag' && event.type !== 'release'
        && (event.x < 1 || event.x >= width - 1 || event.y < 1 || event.y >= height - 1)) return { handled: true };
      return child.handleMouse?.({ ...event, x: event.x - 1, y: event.y - 1, width: width - 2, height: height - 2 });
    },
    render(columns) {
      width = columns;
      if (columns < 3) { const lines = child.render(columns); height = lines.length; return lines; }
      const inner = columns - 2;
      const color = theme.appearance === 'light' ? rgbColor(153, 122, 55) : rgbColor(230, 213, 156);
      const border = text => theme.style(text, { fg: color });
      const lines = child.render(inner).map(line => {
        const text = truncateToWidth(line, inner);
        return border('│') + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + border('│');
      });
      height = lines.length + 2;
      return [border('┌' + '─'.repeat(inner) + '┐'), ...lines, border('└' + '─'.repeat(inner) + '┘')];
    },
  };
}

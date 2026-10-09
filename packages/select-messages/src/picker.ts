import { DynamicBorder, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Key, matchesKey, truncateToWidth, getKeybindings } from '@earendil-works/pi-tui';
import { selectedContext, type Message } from './core.ts';
import { SelectionTreeList } from './tree-list.ts';
import { frame } from './frame.ts';

export function picker(tui: any, theme: any, done: (result?: string) => void,
  tree: any[], messages: Message[], initialId?: string, leafId = initialId) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const selected = new Set<string>();
  const list = new SelectionTreeList(tree, leafId ?? null, Math.max(5, Math.floor(tui.terminal.rows / 2)), initialId, 'no-tools', theme, byId, selected);
  const border = new DynamicBorder();
  let focus = 'list', status = '', inspecting: Message | undefined;
  let markdown: Markdown | undefined, inspectScroll = 0, inspectMax = 0, height = 1;
  let listStart = 0, footerY = 0;
  let controls: { x: number; width: number; action: string }[] = [];
  const render = () => tui.requestRender();
  const toggle = (id = list.getSelectedNode()?.entry.id) => {
    if (id && byId.has(id)) { selected.has(id) ? selected.delete(id) : selected.add(id); status = ''; }
    render();
  };
  const inspect = (id = list.getSelectedNode()?.entry.id) => {
    inspecting = id ? byId.get(id) : undefined;
    if (inspecting) { markdown = new Markdown(inspecting.text, 0, 0, getMarkdownTheme()); inspectScroll = 0; render(); }
  };
  const back = () => { inspecting = undefined; markdown = undefined; focus = 'list'; render(); };
  const activate = (action: string) => {
    if (action === 'cancel') done();
    else if (action === 'back') back();
    else if (action === 'ready') {
      try { done(selectedContext(messages, selected)); }
      catch (e) { status = (e as Error).message; render(); }
    }
  };
  list.onSelect = toggle;
  list.onCancel = () => done();
  return frame({
    focused: false,
    invalidate() { list.invalidate(); markdown?.invalidate(); controls = []; },
    render(width: number) {
      height = Math.max(1, Math.min(Math.floor(tui.terminal.rows / 2), Math.floor(tui.terminal.rows * .85) - 15));
      list.maxVisibleLines = height;
      const lines = ['', ...border.render(width), theme.bold(inspecting ? `  Inspect · ${inspecting.role}` : `  Session Tree · ${selected.size} selected`)];
      lines.push(theme.fg('muted', inspecting ? '  ↑↓/PgUp/PgDn scroll · Esc back' : '  ↑↓ move · ←→ page · Shift+↑↓ branch · Space select · i inspect'));
      const filters = ['default', 'noTools', 'userOnly', 'labeledOnly', 'all'].map(name =>
        `${getKeybindings().getKeys('app.tree.filter.' + name)[0] ?? ''} ${name}`).join(' · ');
      lines.push(inspecting ? '' : theme.fg('muted', '  Filters: ' + filters));
      const query = list.getSearchQuery();
      lines.push(inspecting ? '' : `  ${theme.fg('muted', 'Type to search:')} ${theme.fg('accent', query)}`);
      lines.push(...border.render(width), '');
      listStart = lines.length;
      if (inspecting) {
        const body = markdown!.render(Math.max(1, width - 2));
        inspectMax = Math.max(0, body.length - height); inspectScroll = Math.min(inspectScroll, inspectMax);
        lines.push(...body.slice(inspectScroll, inspectScroll + height).map(line => '  ' + line));
      } else lines.push(...list.render(width));
      // The tree includes a status row. Reserve that same body size in both views.
      while (lines.length < listStart + height + 1) lines.push('');
      lines.push(''); footerY = lines.length;
      controls = []; let footer = '  ';
      for (const [action, label] of inspecting ? [['back', '[Back]']] : [['ready', '[Ready]'], ['cancel', '[Cancel]']]) {
        controls.push({ x: footer.length, width: label.length, action });
        footer += (focus === action ? theme.bg('selectedBg', theme.bold(label)) : label) + '  ';
      }
      lines.push(footer, theme.fg('muted', '  ' + status), ...border.render(width));
      return lines.map(line => truncateToWidth(line, width));
    },
    handleInput(data: string) {
      if (inspecting) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) back();
        else {
          const delta = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1
            : matchesKey(data, Key.pageUp) ? -height : matchesKey(data, Key.pageDown) ? height
            : matchesKey(data, Key.home) ? -Infinity : matchesKey(data, Key.end) ? Infinity : 0;
          inspectScroll = Math.max(0, Math.min(inspectMax, inspectScroll + delta)); render();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) { done(); return; }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
        const choices = ['list', 'ready', 'cancel'], delta = matchesKey(data, Key.tab) ? 1 : -1;
        focus = choices[(choices.indexOf(focus) + delta + choices.length) % choices.length]; render(); return;
      }
      if (matchesKey(data, Key.enter) && focus !== 'list') { activate(focus); return; }
      focus = 'list';
      if (matchesKey(data, Key.space)) toggle();
      else if (data === 'i') inspect();
      else if (data === '/') { /* Optional search prefix; ordinary typing searches directly. */ }
      else if (matchesKey(data, Key.home)) list.selectedIndex = 0;
      else if (matchesKey(data, Key.end)) list.selectedIndex = Math.max(0, list.filteredNodes.length - 1);
      else if (getKeybindings().matches(data, 'app.tree.editLabel') || getKeybindings().matches(data, 'app.message.copy')) { /* Read-only picker. */ }
      else list.handleInput(data);
      render();
    },
    handleMouse(event: any) {
      if (event.type === 'wheel') {
        if (inspecting) inspectScroll = Math.max(0, Math.min(inspectMax, inspectScroll + (event.wheelDelta ?? 0)));
        else list.selectedIndex = Math.max(0, Math.min(list.filteredNodes.length - 1, list.selectedIndex + (event.wheelDelta ?? 0)));
        render(); return { handled: true };
      }
      if (event.type !== 'click' || event.button !== 'left') return;
      if (event.y === footerY) {
        const hit = controls.find(c => event.x >= c.x && event.x < c.x + c.width);
        if (hit) activate(hit.action);
      } else if (!inspecting) {
        const hit = list.hits[event.y - listStart];
        if (hit) {
          list.selectedIndex = hit.index; focus = 'list';
          if (event.x >= 2 && event.x < 5) toggle(hit.id);
          else if (event.x >= 5) inspect(hit.id);
        }
      }
      render(); return { handled: true };
    },
  }, theme);
}

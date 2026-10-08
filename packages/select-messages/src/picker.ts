import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Input, Markdown, Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { treeRows, selectedContext, type Message } from './core.ts';
import { frame } from './frame.ts';

export function picker(tui: any, theme: any, done: (result?: string) => void,
  tree: any[], messages: Message[], initialId?: string) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const selected = new Set<string>();
  let all = false, query = '', rows = treeRows(tree, byId);
  let cursor = Math.max(0, rows.findIndex(r => r.message.id === initialId));
  let scroll = 0, height = 1, follow = true, status = '', focus = 'list', componentFocused = false;
  let inspecting: Message | undefined, markdown: Markdown | undefined, inspectScroll = 0, inspectMax = 0;
  let regions: { x: number; y: number; width: number; action: string; index?: number }[] = [];
  const search = new Input({ prompt: 'Search: ' });
  const render = () => tui.requestRender();
  const setFocus = (value: string) => { focus = value; search.focused = componentFocused && value === 'search' && !inspecting; render(); };
  const update = () => {
    const id = rows[cursor]?.message.id;
    rows = treeRows(tree, byId, all, query);
    cursor = Math.max(0, rows.findIndex(r => r.message.id === id)); follow = true; render();
  };
  search.onSubmit = () => setFocus('list');
  search.onEscape = () => setFocus('list');
  const inspect = () => {
    inspecting = rows[cursor]?.message;
    if (!inspecting) return;
    markdown = new Markdown(inspecting.text, 0, 0, getMarkdownTheme());
    inspectScroll = 0; search.focused = false; render();
  };
  const toggle = () => {
    const id = rows[cursor]?.message.id;
    if (id) { selected.has(id) ? selected.delete(id) : selected.add(id); status = ''; }
    render();
  };
  const activate = (action: string) => {
    if (action === 'ready') {
      try { done(selectedContext(messages, selected)); }
      catch (e) { status = (e as Error).message; render(); }
    } else if (action === 'cancel') done();
    else if (action === 'filter') { all = !all; update(); }
    else if (action === 'inspect') inspect();
    else if (action === 'toggle' || action === 'list') toggle();
    else if (action === 'back') { inspecting = undefined; markdown = undefined; setFocus('list'); }
    else if (action === 'search') setFocus('search');
  };
  const move = (delta: number) => {
    if (inspecting) inspectScroll = Math.max(0, Math.min(inspectMax, inspectScroll + delta));
    else { cursor = Math.max(0, Math.min(rows.length - 1, cursor + delta)); follow = true; setFocus('list'); }
    render();
  };
  return frame({
    get focused() { return componentFocused; },
    set focused(value: boolean) { componentFocused = value; search.focused = value && focus === 'search' && !inspecting; },
    invalidate() { regions = []; search.invalidate(); markdown?.invalidate(); },
    render(width: number) {
      width = Math.max(1, width); regions = [];
      const buttons = inspecting ? [['back', '[Back]']] : [['ready', '[Ready]'], ['cancel', '[Cancel]'], ['filter', all ? '[User/assistant]' : '[All messages]']];
      const footer: { text: string; controls: { x: number; width: number; action: string }[] }[] = [{ text: '', controls: [] }];
      for (const [action, text] of buttons) {
        let row = footer[footer.length - 1];
        if (row.text && visibleWidth(row.text) + text.length > width) { row = { text: '', controls: [] }; footer.push(row); }
        const label = truncateToWidth(text, width), x = visibleWidth(row.text);
        row.controls.push({ x, width: visibleWidth(label), action });
        row.text += (focus === action && !inspecting ? theme.style(label, { inverse: true }) : label) + ' ';
      }
      const previousHeight = height;
      height = Math.max(1, Math.floor(tui.terminal.rows * .85) - 6 - footer.length);
      if (height !== previousHeight) follow = true;
      const display: string[] = [theme.fg('accent', inspecting ? `Inspect · ${inspecting.role}` : `Select messages · ${selected.size} selected`)];
      if (inspecting) {
        display.push('');
        const body = markdown!.render(width);
        inspectMax = Math.max(0, body.length - height); inspectScroll = Math.min(inspectScroll, inspectMax);
        display.push(...body.slice(inspectScroll, inspectScroll + height));
        while (display.length < height + 2) display.push('');
      } else {
        display.push(search.render(width).join(''));
        regions.push({ x: 0, y: 1, width, action: 'search' });
        if (follow) {
          if (cursor < scroll) scroll = cursor;
          if (cursor >= scroll + height) scroll = cursor - height + 1;
          follow = false;
        }
        scroll = Math.max(0, Math.min(Math.max(0, rows.length - height), scroll));
        for (let i = 0; i < height; i++) {
          const index = scroll + i, row = rows[index];
          if (!row) { display.push(i === 0 ? 'No matching messages.' : ''); continue; }
          const text = `[i][${selected.has(row.message.id) ? 'x' : ' '}] ${truncateToWidth(row.prefix, Math.min(16, Math.floor(width / 4)), '…')}${row.message.role} · ${row.message.text.replace(/\s+/g, ' ')}`;
          const clipped = truncateToWidth(text, width);
          display.push(index === cursor && focus === 'list' ? theme.style(clipped, { inverse: true }) : clipped);
          regions.push({ x: 0, y: i + 2, width: Math.min(3, width), action: 'inspect', index });
          if (width > 3) regions.push({ x: 3, y: i + 2, width: Math.min(3, width - 3), action: 'toggle', index });
          if (width > 6) regions.push({ x: 6, y: i + 2, width: width - 6, action: 'highlight', index });
        }
      }
      for (const row of footer) {
        const y = display.length;
        regions.push(...row.controls.map(control => ({ ...control, y })));
        display.push(row.text);
      }
      display.push(status);
      display.push(theme.fg('muted', inspecting ? '↑↓/PgUp/PgDn: scroll · Esc: back' : '↑↓: browse · Space: select · i: inspect · /: search · Tab: controls · Esc: cancel'));
      return display.map(line => truncateToWidth(line, width));
    },
    handleInput(data: string) {
      if (inspecting) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) activate('back');
        else if (matchesKey(data, Key.up)) move(-1);
        else if (matchesKey(data, Key.down)) move(1);
        else if (matchesKey(data, Key.pageUp)) move(-height);
        else if (matchesKey(data, Key.pageDown)) move(height);
        else if (matchesKey(data, Key.home)) move(-Infinity);
        else if (matchesKey(data, Key.end)) move(Infinity);
        return;
      }
      if (focus === 'search' && !matchesKey(data, Key.tab) && !matchesKey(data, Key.shift('tab'))) {
        search.handleInput(data);
        if (query !== search.getValue()) { query = search.getValue(); update(); }
        render(); return;
      }
      if (matchesKey(data, Key.escape)) done();
      else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift('tab'))) {
        const controls = ['list', 'search', 'ready', 'cancel', 'filter'];
        const delta = matchesKey(data, Key.tab) ? 1 : -1;
        setFocus(controls[(controls.indexOf(focus) + delta + controls.length) % controls.length]);
      } else if (matchesKey(data, Key.enter)) activate(focus);
      else if (matchesKey(data, Key.space)) toggle();
      else if (data === 'i') inspect();
      else if (data === '/') setFocus('search');
      else if (matchesKey(data, Key.up)) move(-1);
      else if (matchesKey(data, Key.down)) move(1);
      else if (matchesKey(data, Key.pageUp)) move(-height);
      else if (matchesKey(data, Key.pageDown)) move(height);
      else if (matchesKey(data, Key.home)) move(-Infinity);
      else if (matchesKey(data, Key.end)) move(Infinity);
    },
    handleMouse(event: any) {
      if (event.type === 'wheel') {
        if (inspecting) move(event.wheelDelta ?? 0);
        else { scroll = Math.max(0, Math.min(Math.max(0, rows.length - height), scroll + (event.wheelDelta ?? 0))); follow = false; render(); }
        return { handled: true };
      }
      if (event.type !== 'click' || event.button !== 'left') return;
      const hit = regions.find(r => r.y === event.y && event.x >= r.x && event.x < r.x + r.width);
      if (!hit) return;
      if (hit.index !== undefined) { cursor = hit.index; setFocus('list'); }
      activate(hit.action); render(); return { handled: true };
    },
  }, theme);
}

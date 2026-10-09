export const STATE_TYPE = 'pi-pill-state';

export function parseArgs(input) {
  const tokens = [];
  let token = '', quoted = false, started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
      token += input[++i]; started = true;
    } else if (c === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(c) && !quoted) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else { token += c; started = true; }
  }
  if (quoted) throw new Error('Unmatched quote. Use double quotes around multiword fields.');
  if (started) tokens.push(token);
  if (!tokens.length) return { action: 'inspect' };
  if (tokens.length > 3) throw new Error('Usage: /pipill "label" ["title"] ["description"], or /pipill "label" remove');
  const [label, title, description] = tokens;
  if (!label.trim()) throw new Error('A label is required.');
  if (/[\x00-\x1f\x7f]/.test(tokens.join(''))) throw new Error('Control characters are not allowed.');
  if (label.length > 120 || (title?.length ?? 0) > 500 || (description?.length ?? 0) > 4000)
    throw new Error('Maximum lengths: label 120, title 500, description 4000 characters.');
  if (tokens.length === 2 && title === 'remove') return { action: 'remove', label };
  const optional = value => value && value.toUpperCase() !== 'N/A' ? value : undefined;
  return { action: 'add', pill: { label, title: optional(title), description: optional(description) } };
}

export function toolCommand(params) {
  if (params.action === 'list') {
    if ([params.label, params.title, params.description].some(value => value !== undefined)) throw new Error('List does not accept pill fields.');
    return { action: 'list' };
  }
  if (!['add', 'remove'].includes(params.action)) throw new Error('Unknown pill action.');
  if (typeof params.label !== 'string' || !params.label.trim()) throw new Error('A label is required.');
  for (const value of [params.label, params.title, params.description]) {
    if (value !== undefined && (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Pill fields must be text without control characters.');
  }
  if (params.action === 'remove') {
    if (params.title !== undefined || params.description !== undefined) throw new Error('Remove accepts only an exact label.');
    return parseArgs(JSON.stringify(params.label) + ' remove');
  }
  // Supply all three fields so a title of "remove" is not mistaken for removal.
  return parseArgs([params.label, params.title ?? '', params.description ?? ''].map(s => JSON.stringify(s)).join(' '));
}

export function restore(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom' || entry.customType !== STATE_TYPE) continue;
    const data = entry.data;
    if (data?.version !== 1 || !Array.isArray(data.pills)) throw new Error('Unsupported or malformed saved pill state; no changes made.');
    const labels = new Set();
    for (const p of data.pills) {
      if (!p || typeof p.label !== 'string' || !p.label.trim() || labels.has(p.label)
        || (p.title !== undefined && typeof p.title !== 'string')
        || (p.description !== undefined && typeof p.description !== 'string')) throw new Error('Malformed saved pill state; no changes made.');
      parseArgs([p.label, p.title ?? '', p.description ?? ''].map(s => JSON.stringify(s)).join(' '));
      labels.add(p.label);
    }
    return data.pills.map(p => ({ ...p }));
  }
  return [];
}

export function ticketIds(text, prefixes = []) {
  if (!prefixes.length) return [];
  const keys = prefixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])(${keys})-(\\d+)(?![A-Za-z0-9])`, 'gi');
  return [...new Set([...text.matchAll(pattern)].map(match => `${match[1].toUpperCase()}-${match[2]}`))];
}
export function change(pills, command, ticketPrefixes = []) {
  if (command.action === 'add') {
    if (pills.some(p => p.label === command.pill.label)) return { pills, changed: false, message: 'Pill already exists.' };
    const tickets = ticketIds(command.pill.label, ticketPrefixes);
    const existing = pills.find(p => ticketIds(p.label, ticketPrefixes).some(ticket => tickets.includes(ticket)));
    if (existing) return { pills, changed: false, message: `Ticket already represented by ${existing.label}.` };
    return { pills: [...pills, command.pill], changed: true, message: `Added ${command.pill.label}.` };
  }
  const next = pills.filter(p => p.label !== command.label);
  return { pills: next, changed: next.length !== pills.length, message: next.length === pills.length ? 'Pill not found.' : `Removed ${command.label}.` };
}

// Rendering and hit testing share the same terminal-column layout.
export function layout(pills, width, visibleWidth, truncate, diffAvailable = false) {
  if (width < 1) return { lines: [], regions: [], blocks: [] };
  const lines = [], regions = [], blocks = [];
  let line = '', x = 0, y = 0;
  const append = (text, targets) => {
    const size = visibleWidth(text);
    if (x && x + 1 + size > width) { lines.push(line); line = ''; x = 0; y++; }
    if (x) { line += ' '; x += 1; }
    blocks.push({ x, y, width: size });
    for (const target of targets) if (target.width > 0) regions.push({ ...target, x: x + target.x, y });
    line += text; x += size;
  };
  const launcher = truncate('[+]', width);
  append(launcher, [{ action: 'panel', x: 0, width: visibleWidth(launcher) }]);
  for (const pill of pills) {
    if (width < (diffAvailable ? 10 : 7)) {
      const text = truncate(`[${pill.label}]`, width);
      append(text, [{ action: 'inspect', label: pill.label, x: 0, width: visibleWidth(text) }]);
      continue;
    }
    const label = truncate(pill.label, width - (diffAvailable ? 9 : 6));
    const text = `[${label} (+)${diffAvailable ? '(d)' : ''}]`;
    const plus = visibleWidth(`[${label} `);
    append(text, [
      { action: 'inspect', label: pill.label, x: 0, width: plus },
      { action: 'panel', x: plus, width: 3 },
      ...(diffAvailable ? [{ action: 'diff', label: pill.label, x: plus + 3, width: 3 }] : []),
      { action: 'panel', x: plus + (diffAvailable ? 6 : 3), width: 1 },
    ]);
  }
  if (line) lines.push(line);
  return { lines, regions, blocks };
}

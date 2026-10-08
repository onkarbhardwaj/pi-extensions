export function sourceFromEntry(entry) {
  if (entry?.type !== 'message' || !['user', 'assistant'].includes(entry.message.role)) return null;
  const content = entry.message.content;
  if (Array.isArray(content) && content.some(b => b.type === 'image')) return null;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(b => b.type === 'text').map(b => b.text).join('\n\n') : '';
  if (!text.trim()) return null;
  return { id: entry.id, role: entry.message.role, text, lines: text.split('\n') };
}
export function selectRange(anchor, cursor, count) {
  return { start: Math.max(0, Math.min(count - 1, Math.min(anchor, cursor))), end: Math.max(0, Math.min(count - 1, Math.max(anchor, cursor))) };
}
export function feedback(source, notes) {
  if (!notes.length) throw new Error('Add at least one comment before Ready.');
  return '---\nComments on earlier message from history:\n\n' + notes.map(note => {
    const quote = source.lines.slice(note.start, note.end + 1).join('\n');
    return `${safeText(quote).split('\n').map(l => '> ' + l).join('\n')}\n\n${safeText(note.comment)}`;
  }).join('\n\n') + '\n---';
}
export function appendDraft(existing, annotation) {
  return existing ? existing + '\n\n' + annotation : annotation;
}
// Render source controls as visible text, never executable terminal escape sequences.
export function safeText(text) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).replace(/\t/g, '    ');
}
export function sourceRows(source, width, wrap) {
  const digits = String(source.lines.length).length;
  const prefixWidth = digits + 2;
  const rows = [];
  source.lines.forEach((line, index) => {
    const chunks = wrap(safeText(line) || ' ', Math.max(1, width - prefixWidth));
    chunks.forEach((text, part) => rows.push({ text: (part ? ' '.repeat(prefixWidth) : String(index + 1).padStart(digits) + '  ') + text, sourceLine: index }));
  });
  return rows;
}

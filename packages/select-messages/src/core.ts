export type Message = { id: string; role: string; text: string; conversation: boolean };
export type Row = { message: Message; prefix: string };

export function safeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).replace(/\t/g, '    ');
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'toolCall') return `[Tool call: ${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
    if (block.type === 'thinking') return '[Thinking omitted]';
    return `[${block.type || 'Non-text content'} omitted]`;
  }).join('\n\n');
}

// Select content-bearing entries, not extension state or session bookkeeping.
export function messageFromEntry(entry: any): Message | undefined {
  if (!entry) return;
  let role: string, text: string, conversation = false;
  if (entry.type === 'message') {
    const m = entry.message;
    role = m.role;
    text = contentText(m.content);
    conversation = m.role === 'user' || (m.role === 'assistant' && m.content?.some?.(b => b.type === 'text'));
    if (m.role === 'toolResult') role += ` · ${m.toolName}`;
    if (m.role === 'custom') role += ` · ${m.customType}`;
    if (m.role === 'bashExecution') text = `$ ${m.command}\n${m.output}\n[Exit: ${m.exitCode ?? 'unknown'}${m.cancelled ? '; cancelled' : ''}${m.truncated ? '; output truncated' : ''}]`;
    if (m.role === 'branchSummary' || m.role === 'compactionSummary') text = m.summary;
    if (m.role === 'system' && (m.sections || m.toolsAdded || m.toolsRemoved)) {
      text += '\n' + JSON.stringify({ sections: m.sections, toolsAdded: m.toolsAdded, toolsRemoved: m.toolsRemoved }, null, 2);
    }
  } else if (entry.type === 'custom_message') {
    role = `custom · ${entry.customType}`; text = contentText(entry.content);
  } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    role = entry.type; text = entry.summary;
  } else return;
  if (!text) return;
  return { id: entry.id, role: safeText(role).replace(/\n/g, ' '), text: safeText(text), conversation: Boolean(conversation) };
}

// A linear conversation stays unindented; only branch points add a tree level.
// Iterative traversal also handles long pre-compaction histories.
export function treeRows(tree: any[], messages: Map<string, Message>, all = false, query = ''): Row[] {
  const rows: Row[] = [];
  const stack = tree.map((node, i) => ({ node, lanes: tree.length > 1 ? [i === tree.length - 1] : [], start: tree.length > 1 })).reverse();
  const needle = query.toLocaleLowerCase();
  while (stack.length) {
    const { node, lanes, start } = stack.pop()!;
    const message = messages.get(node.entry.id);
    const visible = message && (all || message.conversation) && `${message.role}\n${message.text}`.toLocaleLowerCase().includes(needle);
    if (visible) {
      const prefix = lanes.map((last, i) => start && i === lanes.length - 1 ? (last ? '└─' : '├─') : (last ? '  ' : '│ ')).join('');
      rows.push({ message, prefix });
    }
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const branch = children.length > 1;
      stack.push({ node: children[i], lanes: branch ? [...lanes, i === children.length - 1] : lanes, start: branch || (!visible && start) });
    }
  }
  return rows;
}

export function selectedContext(messages: Message[], selected: Set<string>): string {
  const chosen = messages.filter(m => selected.has(m.id));
  if (!chosen.length) throw new Error('Select at least one message.');
  return 'Selected conversation history (quoted context):\n\n' + chosen.map(m =>
    `--- BEGIN ${m.role} MESSAGE ---\n${m.text.split('\n').map(line => `> ${line}`).join('\n')}\n--- END ${m.role} MESSAGE ---`).join('\n\n');
}

export function appendDraft(existing: string, context: string): string {
  return existing + (existing ? '\n\n' : '') + context;
}

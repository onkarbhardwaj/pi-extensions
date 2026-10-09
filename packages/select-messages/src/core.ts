export type Message = { id: string; role: string; text: string; conversation: boolean };

export function safeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).replace(/\t/g, '    ');
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block.type !== 'thinking').map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'toolCall') return `[Tool call: ${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
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

export function selectedContext(messages: Message[], selected: Set<string>): string {
  const chosen = messages.filter(m => selected.has(m.id));
  if (!chosen.length) throw new Error('Select at least one message.');
  return 'Selected conversation history (quoted context):\n\n' + chosen.map(m =>
    `--- BEGIN ${m.role} MESSAGE ---\n${m.text.split('\n').map(line => `> ${line}`).join('\n')}\n--- END ${m.role} MESSAGE ---`).join('\n\n');
}

export function appendDraft(existing: string, context: string): string {
  return existing + (existing ? '\n\n' : '') + context;
}

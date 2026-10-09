// Use chronological branch order: Pi puts the summary before retained older entries
// in its context projection. Only inspect contributions still visible to the model.
export function hasRecentReminder(branch: any[], projection: any[], customType: string, content: string): boolean {
  const visible = new Map(projection.map(entry => [entry.sourceEntry.id, entry.messages]));
  let conversation = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === 'compaction') break;
    const messages = visible.get(entry.id) ?? [];
    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      if (message.role === 'custom' && message.customType === customType) return message.content === content;
      if (message.role === 'user' || (message.role === 'assistant' && Array.isArray(message.content)
        && message.content.some(block => block.type === 'text' && block.text?.trim()))) {
        if (++conversation >= 6) return false;
      }
    }
  }
  return false;
}

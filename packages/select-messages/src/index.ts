import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { messageFromEntry, appendDraft, type Message } from './core.ts';
import { picker } from './picker.ts';

export default function (pi: ExtensionAPI) {
  let open = false;
  pi.registerCommand('sel', {
    description: 'Select conversation messages; Ready adds role-labelled quotes to the editor draft.',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('Message selection requires the interactive terminal UI.', 'warning'); return; }
      if (open) return;
      open = true;
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        const entries = ctx.sessionManager.getEntries();
        const messages = entries.map(messageFromEntry).filter((m): m is Message => Boolean(m));
        if (!messages.length) { ctx.ui.notify('No messages to select.', 'info'); return; }
        const byId = new Map(entries.map(e => [e.id, e]));
        const visible = new Set(messages.filter(m => m.conversation).map(m => m.id));
        let initialId = ctx.sessionManager.getLeafId();
        while (initialId && !visible.has(initialId)) initialId = byId.get(initialId)?.parentId ?? null;
        const tree = ctx.sessionManager.getTree();
        const result = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) =>
          picker(tui, theme, done, tree, messages, initialId ?? undefined),
        { overlay: true, overlayOptions: { width: '90%', maxHeight: '85%', anchor: 'center' } });
        if (result !== undefined && ctx.sessionManager.getSessionId() === sessionId) {
          ctx.ui.setEditorText(appendDraft(ctx.ui.getEditorText(), result));
        }
      } finally { open = false; }
    },
  });
}

# Select messages

`/sel` opens a tree-style conversation browser with `[i][ ]` controls. Select several messages, then choose **Ready** to append them to your existing editor draft. Nothing is sent automatically and the session branch is not changed.

From the repository root:

```sh
pi -e ./packages/select-messages
```

For a persistent local install: `pi install ./packages/select-messages`, then `/reload` in an existing Pi session.

## Controls

- **↑/↓**, **Page Up/Down**, **Home/End**: browse. The mouse wheel scrolls the list.
- **Space** or the checkbox: toggle selection.
- **i** or `[i]`: inspect the highlighted message. **Esc** or **Back** returns to the list without losing selections.
- **/**: search message text. Enter or Esc returns focus to the list; clear the search field to show all matches again.
- **Tab / Shift+Tab**, then **Enter**: move between and activate controls.
- **Ready**: append selected messages, in their recorded chronological order, to the current draft.
- **Esc** from the list, or **Cancel**: close without changing the draft.

The initial view shows user and assistant messages. **All messages** also shows tool results, tool-call-only assistant messages, custom messages, system messages, shell output and summaries. Search and view changes retain selections. Extension state and session bookkeeping are not messages and are not offered.

History includes branches and pre-compaction messages still stored in the session. Browsing never navigates the session tree. Selection is local to the open picker; reopening starts a fresh selection.

## Prepared context

Messages have explicit role-labelled delimiters, without entry IDs:

```text
Selected conversation history (quoted context):

--- BEGIN user MESSAGE ---
> An earlier question.
--- END user MESSAGE ---

--- BEGIN assistant MESSAGE ---
> An earlier answer.
--- END assistant MESSAGE ---
```

Tool results also identify the tool. Message bodies are quoted, so any delimiters already in their text remain inside the quote. Images and other non-text blocks are marked as omitted; thinking is omitted. Tool calls include their name and arguments as text, not executable calls. Terminal control characters are made visible.

This quotes stored history into a future prompt; it does not recreate privileged message roles or alter prior messages. Inspection shows the same text that Ready will include. Review the draft before sending.

## Tests

`npm test` runs content, ordering and tree tests. Component/command interaction tests also run when the Pi peer dependencies are available in `node_modules`; otherwise those three tests report a skip. They exercise real Pi input and Markdown components, mouse selection, inspection, search, cancellation, narrow widths and draft handoff.

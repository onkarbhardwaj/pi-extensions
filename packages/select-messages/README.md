# Select messages

`/sel` opens Pi's Session Tree layout in an Annotate-style framed modal with `[ ][i]` controls. The modal keeps the same size when switching between the tree and message previews. Select several messages, then choose **Ready** to append them to your existing editor draft. Nothing is sent automatically and the session branch is not changed.

From the repository root:

```sh
pi -e ./packages/select-messages
```

For a persistent local install: `pi install ./packages/select-messages`, then `/reload` in an existing Pi session.

## Controls

The browser adapts Pi's tree list, retaining its branch layout, active-path markers, centred cursor, search, filters and folding. It uses Pi's configured tree navigation keys.

- **↑/↓**: browse; **←/→** or **Page Up/Down**: page. The mouse wheel moves through the list.
- **Shift+↑/↓**: fold/unfold and navigate branch segments, as in `/tree`.
- **Space**, Enter on a row, or its checkbox: toggle selection.
- **i**, `[i]`, or anywhere after `[i]` on a row: inspect the message. **Esc** or **Back** returns without losing selections.
- Type to search; Backspace removes search characters. Space and `i` are reserved for selection and inspection.
- Pi's tree filter shortcuts remain available: by default **Ctrl+T** no tools, **Ctrl+U** users, **Ctrl+L** labelled, **Ctrl+A** all, **Ctrl+D** default. Selections survive filters and search.
- **Tab / Shift+Tab**, then **Enter**: activate Ready or Cancel.
- **Ready**: append selected messages in their recorded chronological order to the current draft.
- **Esc** from the list, or **Cancel**: close without changing the draft.

The initial filter is the same `no-tools` filter used by Annotate. **Ctrl+A** includes tool results, tool-call-only assistant messages and other content-bearing entries. Extension state and session bookkeeping are not offered. Label editing and clipboard actions are disabled: this picker is read-only.

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

## Tests and attribution

`npm test` runs content and ordering tests. Component/command interaction tests run when the Pi peer dependencies are available; otherwise they report a skip. They exercise real Pi components, mouse selection, inspection, search, cancellation, narrow widths, draft handoff, deep histories and layout parity with Pi's tree browser.

`src/tree-list.ts` adapts Pi's MIT-licensed `TreeList` from `earendil-works/pi`, with permission to copy given during development. The upstream notice is included in `PI-LICENSE`. It uses public Pi imports, not private module paths. The tree layout follows Annotate's Session Tree; the surrounding modal uses Annotate's frame and overlay dimensions.

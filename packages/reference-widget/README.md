# Reference widget

Keep Markdown files in a session reference bar, read them together, and prepare comments on displayed excerpts. `/ref` is the user command; `reference_widget` is the model-callable tool.

## Load

From the repository root:

```sh
pi -e ./packages/reference-widget
```

For a persistent local install, use `pi install ./packages/reference-widget`. Pi supplies its Markdown renderer, theme and terminal components. Mermaid diagrams use `grok-mermaid`, the same rendering library used by Pi. There are no private Pi imports or external rendering services.

## Add references

```text
/ref ./notes.md
/ref "/full/path/with spaces/design.md"
/ref
```

A path adds a reference without opening the reader. Relative paths resolve against the current session working directory; `~/` is supported. References are deduplicated by canonical path, so adding a symlink to the same file does not create another entry.

With no path, `/ref` opens the reader containing all references. Click any basename in the bar to open the same reader with that file selected; `[+]` asks for a file path. Overflow entries open the full reader. Duplicate basenames have numbered labels, while full paths remain in the stored identities and exported feedback.

The model can manage the same list:

```json
{"action":"add","path":"./notes.md"}
{"action":"list"}
{"action":"remove","path":"/full/path/notes.md"}
```

These are arguments to `reference_widget`. Tool results contain reference paths and labels, never file bodies. Adding does not open a modal, submit a prompt or inject the Markdown into model context. Removing unregisters the reference; it never deletes the file.

References persist as session entries. Unsaved/ephemeral sessions can hold memory-only references until a conversation is saved. No global reference database or configuration file is needed.

## Read and annotate

The left pane lists every referenced file and scrolls independently. The right pane renders the selected Markdown with Pi's theme. Supported Mermaid diagrams render as Unicode drawings when they fit; unsupported, warned or oversized diagrams remain visible as source. There is only one reading view.

Select displayed lines, then choose **Comment**. Selection refers to what you see, not Markdown source line numbers. Saved comments retain the displayed excerpt without terminal styling, its file identity and content hash. Resizing clears the unfinished selection rather than moving it silently; saved comments do not change.

- **Tab** changes focus between files, content and controls; **Enter** activates the focused control or comments on the content selection.
- **Up/down** chooses files or displayed lines according to focus. **Left/right** changes files directly.
- **Shift+up/down** or **Shift+click** extends the displayed selection. Click a text row to start one.
- The mouse wheel scrolls the pane under it. Drag the divider or use **[ / ]** to resize the file list.
- Saved comments on the current file have **Edit** and **Delete** controls.
- **Refresh** rereads the selected file. Saved excerpts retain their original text/hash.
- **Remove** unregisters the selected reference without deleting its file or already saved review comments.
- **Ready** gathers comments across files and appends them to the existing Pi editor draft. It never sends automatically or edits a referenced file.
- **Cancel** or Escape closes without changing the editor draft. Reference additions/removals are immediate; unfinished review comments are discarded.

The reader uses a snapshot of the reference list and file contents when opened. External reference-list changes appear on reopening; there are no filesystem watchers. Missing files remain in the list with an error and can be removed or refreshed. Each file must be a regular UTF-8 `.md` or `.markdown` file of at most 2 MiB. Very narrow terminals omit the left pane, but left/right navigation and the selected basename remain available.

Inspect prepared feedback before sending: it contains the selected excerpts, comments and full file paths. Nothing is sent over the network by this extension.

## Search within the viewed file

Click the top-right Search field or press `/` while viewing. The focused field has a highlighted background, accent label and text cursor. Type a literal, case-insensitive query; left/right arrows edit the query and up/down arrows move through matches with wraparound. The counter and arrows appear beside the field while searching. Enter or Esc clears the query, highlights and count, returning to viewing at the current scroll position without closing the modal.

Search covers rendered Markdown text, including off-screen rows, not Markdown syntax or saved comments. Matches are recalculated after resizing or refreshing. Switching files leaves search mode; a new search applies to the newly selected file. Search navigation does not change the annotation selection. While entering a comment or file path, `/`, `n` and `p` are ordinary input.

## Test

Run `npm test` from the repository root or this package. Tests cover path resolution, session restoration, missing/invalid files, displayed-excerpt capture, duplicate basenames and Mermaid width behavior.

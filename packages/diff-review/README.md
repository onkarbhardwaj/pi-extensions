# Diff-review

Interactive local diff review for Pi. Find a checked-out branch across known repositories,
inspect its committed and working changes, select code ranges, and attach comments.

## Load

From this repository, use `pi -e ./packages/diff-review` for one run or
`pi install ./packages/diff-review` for a persistent local installation.

Requires Git and Pi's interactive terminal mode.

## Configure

Create `~/.pi/agent/diff-review/config.json` using
[`config.example.json`](config.example.json). A custom Pi agent directory changes
this location accordingly. Replace the neutral repository placeholder with an
existing local checkout and a valid base ref:

```json
{
  "version": 1,
  "ticketPrefixes": [],
  "repositories": [
    {
      "name": "my-project",
      "path": "~/workspaces/my-project",
      "defaultBase": "origin/main"
    }
  ]
}
```

Each repository needs a name, local path, and default base. The extension inspects
its Git worktrees; it does not clone repositories or fetch missing refs.
Config is read when you open a review, so changes apply on the next `/d` command.
Missing or invalid config produces an error notification.

An empty `ticketPrefixes` list uses case-sensitive literal branch-substring matching.
Set—for example—`["PROJ", "OPS"]` to match recognized ticket IDs case-insensitively
and exactly: `PROJ-12` must not select `PROJ-123`. Keys use letters, digits, or
underscores, starting with a letter, without the hyphen. The field may be omitted
and defaults to an empty list.

Ask Pi: “Read diff-review's README and config example. Ask me which local repositories,
base refs, and optional ticket prefixes to use, then help create my configuration.”

## Review

```text
/d feature-name
/d feature-name --base origin/main
/d PROJ-123
```

A match must identify exactly one checked-out branch. Ambiguous matches are reported
rather than picking an arbitrary worktree.

The snapshot compares the merge base with the working tree, including staged,
unstaged, and untracked non-ignored files. It requires resolved merge conflicts.
Binary, oversized, non-UTF-8, and unsupported Git entries are shown without selectable
code. The snapshot is not refreshed automatically; reopen the review after edits.

- Left/right arrows choose a file; up/down choose a line.
- Shift+up/down or Shift+click extends a selection.
- Tab/Enter choose controls. Comments can be edited or deleted.
- Mouse wheel scrolls; drag the divider or use `[` / `]` to resize the file list.
- **Ready** requires at least one comment and appends review JSON to the Pi editor.
- **Cancel** or Escape leaves the draft unchanged.

Ready does not submit a prompt, post a GitHub review, edit files, or run a model.
Review output includes excerpts, comments, worktree metadata, and content-hash prefixes;
inspect it before sending, particularly when reviewing private code.

If pipill is also loaded, its `(d)` button can open a review using the pill label.

## Test

From this package: `npm test`. From the repository root: `npm test`.

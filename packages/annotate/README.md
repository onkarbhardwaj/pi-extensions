# Annotate

Select text in an earlier conversation message and prepare comments in Pi's editor.
Use `/a` or `/annotate`. The extension works without Tao reminder, pipill, or diff-review.

## Load

From this repository, use `pi -e ./packages/annotate` for one run or
`pi install ./packages/annotate` for a persistent local installation.
After npm publication: `pi install npm:@onkarbhardwaj/pi-annotate`.

Requires Pi's interactive terminal UI. No configuration file or external service is needed.
Disable any older copy before installing to avoid duplicate command registrations.

Ask Pi: “Read annotate's README and explain what I need to use /a to comment on an earlier message.”

## Annotate a message

1. Run `/a` or `/annotate`.
2. Choose a user or assistant text message in Pi's history browser. Selecting it
   does not switch the active conversation branch.
3. Select source lines and choose **Add comment**. Enter saves the comment;
   Escape discards the current comment input.
4. Add more comments, or edit/delete existing ones.
5. Choose **Ready** to append quoted excerpts and comments to your existing editor draft.

Ready requires at least one comment. It does not submit a prompt, run a model,
or rewrite the original message. Inspect the draft and send it yourself.
Cancel or Escape closes the annotation screen without changing the draft.
Unsaved annotation work is not persisted separately.

Messages containing images, tool messages, and messages with no text are not eligible.
Assistant reasoning blocks are not included in the selected source.
Terminal control characters are displayed and exported as visible escaped text.

## Controls

- Up/down moves the selected line; Shift+up/down extends the range.
- Click selects a line; Shift+click extends the range.
- Tab cycles controls; Enter activates one.
- Mouse wheel scrolls. Escape cancels, or exits comment input without saving.
- Comments have **Edit** and **Delete** controls.

The history picker uses Pi's own tree selector. The annotation screen uses an overlay
and supports keyboard operation without a mouse.

## Test

From this package: `npm test`. From the repository root: `npm test`.

# Busywork

Reminders and heartbeats for a Pi session, and notes shared by every Pi agent, shown together in clickable indicators below the editor.

## Reminders

```text
/remind 30m Check CI
/remind 15:30 Prepare for the review
```

Reminders do not call a model or wake the agent. When one becomes due, it waits until Pi is idle, shows one notification, and stays in the indicator until dismissed or snoozed for 15 minutes.

Times can be durations (`30m`, `2h`, `1d`), a local clock time (`15:30`), or a future ISO date. A clock time that has already passed today schedules for tomorrow.

## Heartbeats

```text
/heartbeat 5m pr-ci Check PR CI and report only meaningful changes
/heartbeat 15m until 2h review Summarize new review comments
```

A heartbeat sends its instruction to the agent on an interval. It starts a turn only when Pi is idle and has no queued messages. If several intervals are missed, it runs once, then schedules the next interval from that run. The minimum interval is five minutes, and `until` sets an optional expiry.

## Panel

The indicators stay visible when empty: `⏰ No reminders`, `♥ No heartbeats` and `📝 No notes`. Click the reminders indicator or run `/reminders` to manage reminders. Click the heartbeats indicator or run `/heartbeats` to manage heartbeats. Reminders have **Dismiss** and **Snooze**. Heartbeats have **Pause** or **Resume**, and **Stop**. Click a heartbeat name to show its instruction and latest result. When the list is taller than the panel it scrolls with the wheel or Page Up and Page Down, the view follows the focused button, and a scrollbar on the right shows the position. Clicking the scrollbar track pages toward the click.

The agent tools `reminder` and `heartbeat` support the same management actions. They should change schedules only when the user asks.

State is saved in the session and restored on resume. Schedules run only while that Pi session is open. A reminder that becomes due while Pi is closed is marked missed.

## Notes

One short Markdown file that every Pi agent keeps in mind: what matters today, decisions, things not to forget. By default it is `~/.pi/agent/busywork/notes.md`; set another absolute or `~/` path in `~/.pi/agent/busywork.json`:

```json
{ "notes": { "path": "~/notes/pi-notes.md" } }
```

Click `📝 Notes` below the editor, or run `/notes`, to edit it in a full-screen Markdown editor with a live preview (Mermaid diagrams included). The file's first line is a comment saying that every Pi agent sees it; saving restores the line if it was removed, and it is never sent to the model.

A model sees the notes only when they change. Before each run, busywork checks whether this session's context already holds the current version; if not (an edit from anywhere, including another agent or an outside editor, or compaction dropped the earlier copy), it adds one message with the full notes. Unchanged notes cost nothing.

The `note` tool lets an agent `show`, `append` to, or `replace` the notes when the user asks. `append` adds to the end without rewriting, so concurrent appends both survive. `replace` needs the hash returned by `show` and is refused if the notes changed since. The editor likewise asks before overwriting a file that changed while it was open. Notes are limited to 20,000 characters.

## Helpers

`helpers/meetings.swift` lists one day's macOS Calendar meetings with your RSVP status
(accepted, tentative, declined, invited, organizer, own, unknown). Only the source is
committed; build it locally as a small app bundle:

```text
helpers/build.sh
```

This makes `helpers/bin/Busywork Meetings.app`. macOS grants calendar access per app, and
a plain command-line helper inherits whatever app started Pi (a terminal, or an app such as
Herdr). If that app never asks for calendar access, it can't be granted, and the helper
fails with "Calendar access denied" without appearing in System Settings. The bundle asks
for itself instead: the first sync shows a prompt for "Busywork Meetings", after which it
appears under System Settings → Privacy & Security → Calendars. Rebuilding asks once more,
because the ad-hoc signature changes.

busywork prefers the bundle when it is built and runs it with `open`. The plain binary still
works where the terminal already has calendar access:

```text
swiftc -O helpers/meetings.swift -o helpers/bin/meetings
helpers/bin/meetings [today|tomorrow|YYYY-MM-DD] [--json] [--out FILE]
```

## Meeting reminders

When the helper is built, busywork runs it every 15 minutes in terminal mode and adds
a reminder 5 minutes before each upcoming meeting you accepted, marked tentative,
organized, have not answered, or were invited to without being listed individually
(`unknown`, such as invitations sent to a group). Reminders read `📅 <title> at <time>`;
unanswered invitations add `(no reply)`.

- Syncing again never duplicates a meeting, and a dismissed meeting is not added back.
- Snoozed meeting reminders keep their snoozed time.
- If a meeting is cancelled, declined, moved, or deleted, its still-scheduled reminder is
  removed; a moved meeting gets a new reminder.

Configure it in `~/.pi/agent/busywork.json` (see [`config.example.json`](config.example.json)).
Set `"enabled": false` to turn meeting sync off. `command` points to a different helper,
`leadMinutes` and `intervalMinutes` (at least 5) set timing, and `statuses` chooses which
RSVP states get reminders. Reload Pi after changing the file.

## Test

From this package: `npm test`. From the repository root: `npm test`.

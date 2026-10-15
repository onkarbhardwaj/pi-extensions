# Busywork

Reminders and heartbeats for a Pi session, shown together in one clickable indicator below the editor.

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

The indicators stay visible when empty: `⏰ No reminders` and `♥ No heartbeats`. Click the reminders indicator or run `/reminders` to manage reminders. Click the heartbeats indicator or run `/heartbeats` to manage heartbeats. Reminders have **Dismiss** and **Snooze**. Heartbeats have **Pause** or **Resume**, and **Stop**. Click a heartbeat name to show its instruction and latest result.

The agent tools `reminder` and `heartbeat` support the same management actions. They should change schedules only when the user asks.

State is saved in the session and restored on resume. Schedules run only while that Pi session is open. A reminder that becomes due while Pi is closed is marked missed.

## Helpers

`helpers/meetings.swift` lists one day's macOS Calendar meetings with your RSVP status
(accepted, tentative, declined, invited, organizer, own, unknown). Only the source is
committed; compile it locally:

```text
swiftc -O helpers/meetings.swift -o helpers/bin/meetings
helpers/bin/meetings [today|tomorrow|YYYY-MM-DD] [--json]
```

The first run asks macOS for calendar access for the calling terminal.

## Meeting reminders

When the helper is compiled, busywork runs it every 15 minutes in terminal mode and adds
a reminder 5 minutes before each upcoming meeting you accepted, marked tentative, or
organized. Reminders read `📅 <title> at <time>`.

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

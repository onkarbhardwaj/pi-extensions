# Reminders

Session reminders for Pi. Reminders do not call a model or wake the agent. When a reminder becomes due, it waits until Pi is idle, shows one notification, and remains visible in the footer until dismissed.

## Use

```text
/remind 30m Check CI
/remind 2h Follow up with the team
/remind 15:30 Prepare for the review
/reminders
```

Times can be durations (`30m`, `2h`, `1d`), a local clock time (`15:30`), or a future ISO date. A clock time that has already passed today schedules for tomorrow.

`/reminders` opens one panel with direct **Dismiss** and **Snooze 15m** buttons for every reminder. Use the mouse in fullscreen mode, or Tab and Enter from the keyboard. The agent tool supports `list`, `add`, and `remove`; it should change reminders only when the user asks.

## Behavior

The footer shows `⏰ N scheduled · next HH:MM`, or `⏰ N due` when something needs attention. A due reminder stays in that state until dismissed or snoozed.

Reminders are saved as session entries and restored on resume. They run only while that Pi session is open. If a reminder becomes due while Pi is closed, it is marked missed when the session starts again.

## Test

From this package: `npm test`. From the repository root: `npm test`.

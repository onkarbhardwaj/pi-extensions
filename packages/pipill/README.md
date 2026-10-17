# Pipill

Session reminder pills for Pi. Keep topics visible without switching conversations,
add short descriptions, and inspect or remove them through a terminal panel or the
model-callable `pipill` tool.

## Load

From this repository, use `pi -e ./packages/pipill` for one run or
`pi install ./packages/pipill` for a persistent local installation.

## Configure

Configuration is optional. Create `~/.pi/agent/pipill.json` from
[`config.example.json`](config.example.json). A custom Pi agent directory changes this
location accordingly. The neutral default is:

```json
{ "ticketPrefixes": [] }
```

To recognize your issue tracker's project keys, set—for example—`["PROJ", "OPS"]`.
Use letters, digits, or underscores, starting with a letter; do not include the hyphen.
Keys are case-insensitive and normalized to uppercase.

Configured prefixes enable guidance to auto-add pills for substantive ticket discussions
and prevent duplicate pills for the same ticket ID. With no prefixes, exact-label
deduplication still works and arbitrary labels remain allowed. GitHub has no universal
project-key prefix; this setting does not interpret bare `#123` references.

For other topics discussed over 2–3 user turns, the extension asks the agent to offer a
pill and wait for agreement. It also asks the agent to add pills when requested, remove
only by exact label and request, and avoid duplicates. These are model instructions,
not deterministic detection of discussions. Guidance and current labels share one hidden
reminder. Before each user prompt, the extension checks for its most recent reminder
within six model-visible user/assistant text messages, stopping at the actual compaction
entry. If that reminder has the same content, it adds nothing. Otherwise it appends a
fresh reminder, including when labels or configured guidance changed. Tool results,
tool-call-only assistant messages and other reminders do not advance the interval.
Past reminders stay untouched; a summary mentioning them does not count. The check
uses active-branch chronology and Pi's resolved projection, so omitted reminders and
retained pre-compaction reminders cannot suppress a fresh one. Label changes made
through the UI reach model context at the next user prompt; they never trigger a turn.

Ask Pi: “Read pipill's README and config example. Ask me which ticket prefixes I use,
then help create my configuration.” Reload Pi with `/reload` after changing config.
Missing config uses the neutral default; malformed config reports an extension-load
error.

## Use

```text
/pipill "release-notes" "Release notes" "Draft the next release summary"
/pipill "release-notes" remove
/pipill
```

No arguments opens the inspection panel. The agent tool supports `list`, `add`, and
`remove`. Labels are case-sensitive for removal; optional titles and descriptions
provide more context.

The widget appears below the editor in terminal mode. Click a pill to inspect it;
use Tab/Enter, Escape, or the mouse in the panel.

## Ticket pills

A pill whose label contains a configured ticket ID is a ticket pill. When Pi starts on a
branch whose name contains a ticket ID, that ticket's pill is added automatically.

Every 5 minutes while the session is open, pipill asks GitHub (`gh`) for PRs whose
title or branch contains the ticket ID. It searches the configured `repos`, or the
current repository when none are configured. Use `host/owner/repo` for GitHub Enterprise. The pill then shows up
to two icons and a diff button:

```text
[DCAI-2425 font export ❌·❗·🔍]
```

- CI: ⏳ running, ❌ failed, ✅ passed.
- Review: ❗ changes requested or merge conflict, 👍 approved, 🔀 merged.
- 🔍 opens diff review for the matched PR's branch, or for a local branch named after the ticket when there is no PR.

The panel shows topic pills under **Topics** and ticket pills under **Tickets**; the bar uses the same order.
Each pill is rendered with Pi's Markdown theme: the label as a heading (ticket pills add the bar's
status icons), then the title and description as Markdown, then matched PRs as a list with their
state, links, and failing checks. Buttons say **Remove topic** or **Remove ticket**, and ticket pills add **Diff**. **Refresh** checks
again immediately. Notifications appear
when CI starts failing, a review needs attention, or a PR merges.

Some repositories have checks that always fail or are not CI. Ignore them per repository
by full check name or by the job name after `: `:

```json
{
  "ticketPrefixes": ["PROJ"],
  "repos": ["org/repo", "github.example.com/team/service"],
  "ci": { "org/repo": { "ignore": ["backend-banned-deps", "Kodiak"] } }
}
```

Pills are saved as custom session entries and restored on resume. They are shared
across navigation within that session, not stored in this package or a global JSON
file. A session without a saved conversation may have memory-only pills.
The tool and prompt context also work without terminal UI; panels require terminal mode.

Other extensions may query current labels through the read-only `pi-pills:current`
event with the current `sessionId`. It returns labels only for the matching active session.

## Timelines

Each pill can keep a short timeline of updates, written in the background. Turn it on in
`pipill.json`:

```json
"timeline": { "enabled": true, "provider": "github-copilot", "model": "claude-haiku-5.5" }
```

After a turn settles and at least `minMessages` (default 6) new user or assistant messages exist,
pipill runs one separate Pi process with no session, extensions, tools, skills, or MCP servers.
It sends the new message text, each pill's label, title, description, and its last three updates,
and asks for a one-sentence headline (two at most, 200 characters) per pill whose subject moved forward, or nothing.
The user never waits for it.

- The run is stopped after `timeoutSeconds` (default 20).
- Output must be JSON for known pills. Anything else is discarded and nothing is saved.
- On failure the panel shows the error, the same messages are covered next time, and retries
  back off from 2 to 30 minutes.
- Updates are saved in the session, so they survive resume. Removing a pill keeps its timeline;
  adding the pill again shows it.

In the panel, a pill with updates shows **+** before its title. **+** expands the full timeline,
newest first, and **-** hides it again. **Delete timeline** appears when expanded and asks for a second
press. Pill descriptions help the summarizer recognise which messages belong to which pill.

## Test

From this package: `npm test`. From the repository root: `npm test`.

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
not deterministic detection of discussions. Current labels are included as hidden
context before each prompt.

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
use Tab/Enter, Escape, or the mouse in the panel. The `(d)` button appears only when
diff-review is available in the current terminal session. Click it to review the
branch matching that pill's label.

Pills are saved as custom session entries and restored on resume. They are shared
across navigation within that session, not stored in this package or a global JSON
file. A session without a saved conversation may have memory-only pills.
The tool and prompt context also work without terminal UI; panels require terminal mode.

Other extensions may query current labels through the read-only `pi-pills:current`
event with the current `sessionId`. It returns labels only for the matching active session.

## Test

From this package: `npm test`. From the repository root: `npm test`.

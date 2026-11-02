# Running Pi agents in the Herdr app

How to run long-lived Pi agents in the Herdr desktop app so that each one has a name `hc` can address, keeps its Pi session, and shows up in the app's agents list.

Herdr app 0.1.x runs on herdr-core (`hc`). It is not the older Herdr TUI: agents started there don't appear in the app, and the old `herdr` commands don't reach agents in the app.

## The rule that shapes everything

**An `hc` name can only be set when a terminal starts.** There is no rename. To make an agent addressable as `hc send planner …`, start Pi itself as the terminal's program with `--name`:

```sh
hc run --bg --no-parent \
  --name <name> \
  --cwd <working folder> \
  --label herdr.space=<space id> \
  <full path to pi> --session <session file or id>
```

- `--name`: what `hc send`, `hc wait`, `hc read` and the agents list use. Lowercase letters, digits, `-` and `_`; unique among live terminals.
- `--label herdr.space=<id>`: makes the terminal appear in that app space, in a new tab. Without a `herdr.*` label it runs hidden. Find space IDs with `herdr-app ls`.
- `--session`: resumes the agent's existing Pi session, so its history, name and settings come back.
- **The full path to `pi`**: the core may not see nvm's PATH (`cannot start "pi": No such file or directory`). Use `$(which pi)` from your shell.
- `--no-parent`: the agent isn't tied to whoever ran the command, so it keeps running when that terminal ends.

Then name the tab: `herdr-app do tab.rename --id <tab id> --name <Name>` (tab IDs are in `herdr-app ls`).

## The agent is the terminal

Pi is the terminal's program, not a shell running Pi. So:

- `hc send <name>` always reaches the agent, never a shell prompt, and the terminal's status is Pi's own (Pi reports OSC 7501 itself; no extension needed).
- **Quitting Pi ends the terminal and closes its tab.** To bring the agent back, run the same `hc run` command again with the same `--session`.

The alternative, a named shell with Pi started inside it, keeps the tab after Pi quits, but `hc send <name>` would then type into the shell. The agent being the terminal is usually the better trade.

## Moving an agent (from the old Herdr TUI, or restarting one)

1. **Quit the running Pi first** (`/quit`). Two Pi processes on one session file can fork its history. Before typing `/quit` into an agent's input, check the input box is empty and the agent is idle: text typed after an unsent draft is sent as one prompt.
2. Find its session: Pi stores sessions under `~/.pi/agent/sessions/<folder>/`, and the session name is in the file's latest `session_info` line. Search with `rg -l '"name":"<name>"' ~/.pi/agent/sessions/*/*.jsonl`.
3. Start it with the command above, in the right space. To open a new space: `herdr-app do space.new --name <name> --folder <folder>`. This also opens a default shell tab, which you can close.
4. Rename the tab, then check it: `hc get <name>` should show `status: idle`, and `hc read <name> --lines 5` shows Pi's footer with the session name.

## Example

Restart an agent named `planner` in an app space named `work`, resuming its session:

```sh
hc run --bg --no-parent --name planner --cwd ~/projects/app \
  --label herdr.space=$(herdr-app ls | jq -r '.spaces[] | select(.name=="work") | .id') \
  "$(which pi)" --session <session id>
```

Space names can be renamed in the app at any time, and the lookup above then finds nothing (an empty `herdr.space=` label). Check `herdr-app ls | jq -r '.spaces[] | "\(.name) \(.id)"'` and use the current name or the ID.

Keep your own list of agents (name, space, folder, session ID) outside this repo, so restarting one is a copy and paste.

## Talking to them

`hc send <name> "…"`, `hc wait <name>`, `hc read <name> --lines 100`. A child agent reports back with `hc send $HC_TERMINAL_ID "…"`, and the report arrives tagged `<hc from="…">`. `hc --skill` and `herdr-app --skill` are the full references and always match the installed version.

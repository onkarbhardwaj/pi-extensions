# Running Pi agents in the Herdr app

How we run long-lived Pi agents (Tao, Reporter, Mitchellh, Venus) in the Herdr desktop app so that each one has a name `hc` can address, keeps its Pi session, and shows up in the app's agents list.

Herdr app 0.1.x runs on herdr-core (`hc`). It is not the older Herdr TUI: agents started there don't appear in the app, and the old `herdr` commands don't reach agents in the app.

## The rule that shapes everything

**An `hc` name can only be set when a terminal starts.** There is no rename. To make an agent addressable as `hc send tao …`, start Pi itself as the terminal's program with `--name`:

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

The alternative, a named shell with Pi started inside it, keeps the tab after Pi quits, but `hc send <name>` would then type into the shell. We prefer the agent being the terminal.

## Moving an agent (from the old Herdr TUI, or restarting one)

1. **Quit the running Pi first** (`/quit`). Two Pi processes on one session file can fork its history.
2. Find its session: Pi stores sessions under `~/.pi/agent/sessions/<folder>/`, and the session name is in the file's latest `session_info` line. Search with `rg -l '"name":"<name>"' ~/.pi/agent/sessions/*/*.jsonl`.
3. Start it with the command above, in the right space. To open a new space: `herdr-app do space.new --name <name> --folder <folder>`. This also opens a default shell tab, which you can close.
4. Rename the tab, then check it: `hc get <name>` should show `status: idle`, and `hc read <name> --lines 5` shows Pi's footer with the session name.

## Our agents

| Name | Space | Working folder | Session |
|---|---|---|---|
| `tao` | workspaces | `~/workspaces` | `01a12c98-f502-71b9-a77b-13542c772e60` |
| `reporter` | workspaces | `~/workspaces` | `01a1846f-917e-7686-bc54-6dc247f332c1` |
| `mitchellh` | agentic-avalon-workspace | `~/workspaces/agentic-avalon-workspace` | `01a09172-2327-7377-8764-f9944b3e110b` |
| `venus` | venice | `~/workspaces/agentic-venice-workspace` | `01a0a0b9-6dfa-7775-918f-bb89a2181487` |

Restart one, for example Tao:

```sh
hc run --bg --no-parent --name tao --cwd ~/workspaces \
  --label herdr.space=$(herdr-app ls | jq -r '.spaces[] | select(.name=="workspaces") | .id') \
  "$(which pi)" --session 01a12c98-f502-71b9-a77b-13542c772e60
```

## Talking to them

`hc send <name> "…"`, `hc wait <name>`, `hc read <name> --lines 100`. A child agent reports back with `hc send $HC_TERMINAL_ID "…"`, and the report arrives tagged `<hc from="…">`. `hc --skill` and `herdr-app --skill` are the full references and always match the installed version.

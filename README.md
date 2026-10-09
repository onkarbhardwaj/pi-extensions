# Pi extensions

Five extensions for [Pi](https://pi.dev), each with its own commands and setup:

- [Pipill](packages/pipill/README.md): keep session reminders visible and let the agent manage them.
- [Diff-review](packages/diff-review/README.md): select code changes and prepare review comments with `/d <branch-name>`.
- [Annotate](packages/annotate/README.md): comment on earlier conversation messages with `/a` or `/annotate`.
- [Reference widget](packages/reference-widget/README.md): keep Markdown references in a session bar and read/comment on rendered content with `/ref`; the agent uses `reference_widget`.

- [Select messages](packages/select-messages/README.md): select conversation messages with `/sel` and append role-labelled quotes to the editor draft.

## Install

Requires Pi and Node 22.18 or newer.

```sh
pi install git:github.com/onkarbhardwaj/pi-extensions
```

Use `pi config` to choose which extensions are enabled. Remove or disable older copies
before switching to avoid duplicate command and tool registrations.
The individual npm packages are not yet published.

#### Configuring plugins
- Pipill has optional ticket-prefix configuration to give it better context.
- Diff-review needs local repository paths and base refs so that it can search branches to show diffs.
- Annotate, Reference widget and Select messages need _no configuration_.
- See each extension's README for commands, controls, and setup.

You can ask Pi: “Read this extension's README, tell me what information you need,
and help me set it up.”

## Develop

From a checkout:

```sh
npm install --ignore-scripts --legacy-peer-deps
npm test
npm run pack:check
```

Try one extension without installing it:

```sh
pi -e ./packages/pipill
pi -e ./packages/diff-review
pi -e ./packages/annotate
pi -e ./packages/reference-widget
pi -e ./packages/select-messages
```

The repository is an npm workspace with five separately versioned packages.
Pi loads their TypeScript directly; no build step is needed.
Each package declares its Pi entry point and host-provided peer dependencies.
Package archives exclude tests and personal configuration.

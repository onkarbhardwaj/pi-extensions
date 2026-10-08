# Pi extensions

Three extensions for [Pi](https://pi.dev), each with its own commands and setup:

- [Pipill](packages/pipill/README.md): keep session reminders visible and let the agent manage them.
- [Diff-review](packages/diff-review/README.md): select code changes and prepare review comments with `/d`.
- [Annotate](packages/annotate/README.md): comment on earlier conversation messages with `/a` or `/annotate`.

## Install

Requires Pi and Node 22.18 or newer.

```sh
pi install git:github.com/onkarbhardwaj/pi-extensions
```

Use `pi config` to choose which extensions are enabled. Remove or disable older copies
before switching to avoid duplicate command and tool registrations.
The individual npm packages are not yet published.

Pipill has optional ticket-prefix configuration. Diff-review needs local repository
paths and base refs. Annotate needs no configuration. See each extension's README
for commands, controls, and setup.

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
```

The repository is an npm workspace with three separately versioned packages.
Pi loads their TypeScript directly; no build step is needed.
Each package declares its Pi entry point and host-provided peer dependencies.
Package archives exclude tests and personal configuration.

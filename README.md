# Pi extensions

Three independently installable [Pi](https://pi.dev) extensions:

- [Pipill](packages/pipill/README.md): session reminder pills, an agent tool, and configurable ticket guidance.
- [Diff-review](packages/diff-review/README.md): interactive local diff selection and review comments.
- [Annotate](packages/annotate/README.md): select conversation text and prepare feedback with `/a` or `/annotate`.

None requires Tao reminder. If both are loaded, a pill's `(d)` button can open diff-review; that integration is optional.

## Try locally

Use Node 22.18 or newer. From this checkout:

```sh
npm install --ignore-scripts --legacy-peer-deps
pi -e ./packages/pipill
pi -e ./packages/diff-review
pi -e ./packages/annotate
```

Local paths can also be installed persistently with `pi install ./packages/pipill`.
The root Pi manifest exposes all three extensions for a whole-repository Git or local install.
Disable any older copies before switching to avoid duplicate tool/command registrations.

Pipill and diff-review have neutral config examples and setup instructions. Annotate needs no configuration. You can ask Pi:
“Read this extension's README and config example, tell me what information you need, and help me configure it.”

## Develop and package

```sh
npm test
npm run pack:check
```

The root is a private npm workspace. The three leaf packages have independent versions,
explicit Pi entry points, and public npm publish settings. They have not been published.
Once published, users can install them independently with `pi install npm:@onkarbhardwaj/pi-pipill`,
`pi install npm:@onkarbhardwaj/pi-diff-review`, or `pi install npm:@onkarbhardwaj/pi-annotate`.

Package archives include source, documentation, license, and neutral configuration examples,
not tests or personal settings. Pi loads TypeScript directly; no compilation step is needed.
Host-provided Pi libraries are peer dependencies, not bundled copies.

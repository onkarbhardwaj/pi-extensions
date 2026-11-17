# PR queue

A pull request review queue shared by every Pi session. Agents add PRs, from any
repository and not only your own, with a note and a priority; the queue shows each PR's
CI and review status from GitHub.

## Requirements

[GitHub CLI](https://cli.github.com) (`gh`), signed in to every host whose PRs you queue.
GitHub Enterprise hosts work too: `gh auth login --hostname github.example.com`.

## Load

From this repository, use `pi -e ./packages/pr-queue` for one run or
`pi install ./packages/pr-queue` for a persistent local installation.

## Use

A chip shows how many PRs are left to review and how many are waiting on someone else:

```text
👀 3 · ⏳ 2
```

With [Busywork](../busywork/README.md) loaded, the chip joins its row; otherwise it appears in
Pi's status line. Click the chip, or run `/prq`, to open the queue:

```text
👀 To review (2)

▾ widgets #2712: Add usage analytics · ✅ CI · Review required · [✕]
    octocat · added by assistant 11-16 · Open since: 2d · Priority: High
    Asked for timing from the request start. Re-check after the author updates.
▸ widgets #2729: Type-check the CLI package · ❌ CI · ❗ Changes requested · [✕]

⏳ Waiting (1)

▸ gadgets #81: Pin the YAML parser · ✅ CI · ❗ Conflict · [✕]

▸ Done (4)
```

- Click a row's arrow, or press Enter on it, to show the author, who added it and when, how
  long the PR has been open, its priority, failing checks, and the note.
- Click the PR reference to open it in your browser.
- `[✕]` removes the PR from the queue; it asks for a second press.
- Approved, merged and closed PRs move to **Done**. Nothing leaves the queue unless removed.
- Status refreshes every 5 minutes, and when the queue changes. **Refresh** checks again now.
  Notifications appear when CI fails, a PR gets a conflict or a change request, or a PR merges.

The queue file is `~/.pi/agent/pr-queue/queue.json` (or under your custom Pi agent directory).
Every session watches it, so a PR added in one session appears in all of them.

## Agent tool

`pr_queue` supports `list`, `add`, `update` and `remove`:

- `pr`: a PR URL, `owner/repo#123`, or `host/owner/repo#123` for GitHub Enterprise.
- `section`: `review` (needs your review; the default) or `waiting` (waiting on someone else).
- `priority`: `high`, `medium` or `low`; `none` clears it.
- `note`: free text shown when the PR is expanded, such as why it matters or a link to a discussion.
- `addedBy`: who added it.

Adding a PR that is already queued updates it instead of duplicating it.

## Configure

Configuration is optional. To keep advisory checks from turning a PR's CI red, create
`~/.pi/agent/pr-queue.json` from [`config.example.json`](config.example.json): `ci` maps
`owner/repo` to check names to ignore. A name matches a whole check or the job after `: `.

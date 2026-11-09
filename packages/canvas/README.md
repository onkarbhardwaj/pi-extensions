# Canvas

Lay out versions of a design as live frames on one canvas, look at them side by side in a browser, and comment on them. The agent adds and updates frames with the `canvas` tool; your comments come back to it.

Everything stays on your machine: no account, no sharing, no network service.

## Load

From the repository root, `pi -e ./packages/canvas` for one run, or `pi install ./packages/canvas` to keep it. Requires Node 22.18 or newer.

## Set up

Optional settings live in `~/.pi/agent/canvas.json` (see `config.example.json`):

```json
{
  "port": 4848,
  "storage": "~/.pi/agent/canvas",
  "comments": "live",
  "browser": { "cdp": "http://127.0.0.1:9222" }
}
```

- `port`: where the canvas server listens on `127.0.0.1`. Default 4848.
- `storage`: where canvases are kept, absolute or `~/`. Default `~/.pi/agent/canvas`. Nothing is written into your projects.
- `comments`: `live` (default) sends your comments to the agent when they change; `review` sends nothing until you run `/canvas comments`.
- `browser.cdp`: a Chrome DevTools address. With it, the agent gets a screenshot of every frame it adds or updates, and `/canvas` opens the canvas in that browser. Start Chrome or Chromium with `--remote-debugging-port=9222` and a separate `--user-data-dir`. Without it, the canvas still works: `/canvas` prints its address and the agent gets no screenshots.

Ask Pi: “Read canvas's README and help me set it up.”

## Use

Ask the agent, for example: “Design three versions of a todo app on the canvas: compact, roomy and dark.” It reads the tool's guide, builds each version as a folder of static files, adds them, and checks the screenshots.

- `/canvas` opens the current project's canvas (or prints its address); `/canvas <name>` opens another.
- `/canvas comments` appends the open comments to your editor draft without sending.
- With busywork enabled, a `🖼 Canvas · 3 frames · 2 comments` chip joins its row below the editor; click it to open the canvas. Without busywork, the same text shows in Pi's status line.

On the canvas page:

- Drag the background or scroll to pan; Ctrl+scroll, `+` and `−` zoom; `F` fits all frames; double-click a frame's title to fit it.
- Frames are live: click, type and scroll inside them.
- Drag a frame by its title to move it.
- **Comment** (or `C`), then click a point on a frame and type; Enter saves. Click a pin to edit, resolve or delete.

If the Pi session that hosts the server quits, an open canvas page shows that it is disconnected and is read-only until a session uses the canvas again; then it reconnects by itself.

## How it works

**Frames.** A frame is a folder of static files, copied into storage when added or updated. Each is served from its own origin, `http://<frame>--<canvas>.localhost:<port>/`, so it can use `localStorage` without reaching the canvas or other frames. Its responses carry a content policy that allows its own files and nothing else: requests to other addresses and form posts fail. Folders with `.env` files, keys, credentials, databases, source maps, `node_modules`, `package.json` or symbolic links are refused, with a fix for each problem. Limits: 50 MB and 2,000 files per frame, 10 MB per file, 200 frames per canvas.

**Storage.** `~/.pi/agent/canvas/<canvas>/` holds `canvas.json`, `manifest.json`, `comments.json`, `frames/` and `shots/`. Writes go through temporary files and a lock, so concurrent changes from several agents and the page never leave half a file. Every frame has a hash; `update`, `move` and `remove` must carry the hash last seen and are refused if the frame changed since. Adding never rewrites other frames.

**Server.** One per machine, inside whichever Pi session holds the port. A session that needs it and finds the port taken asks `/health` and uses that server; when the hosting session ends, the next session that needs the canvas takes over on the same port. There is no polling.

**Comments.** In `live` mode, before each agent turn the extension checks whether the model has seen the current open comments; if not, it adds one message with them, marking new ones and counting those resolved since. Unchanged comments cost nothing.

**Screenshots.** Taken over the DevTools protocol in a separate, temporary browser context, so your tabs, cookies and logins are never touched; the connection only ever disconnects, it never closes the browser. In a windowed browser, the temporary window may show briefly.

## The tool

`canvas` with an `action`: `guide`, `add` (`frames: [{ folder, title, width, height, entry?, newRow? }]`, all or none), `update` (`frame`, `hash`, `folder`, optional `title`, `entry`, `width`, `height`), `move` (`frame`, `hash`, `x`, `y`), `remove` (`frame`, `hash`), `list`, `screenshot` (`frame`), `show` (`show?: [frames]`), `comments` (`frame?`, `includeResolved?`), `canvases`. Every action takes an optional `canvas` name; by default it is the last canvas used from the current project, or one named after its folder.

## Test

From this package: `npm test`. The browser test runs when a Chromium is found (set `CANVAS_TEST_CHROME` to its path) and is skipped otherwise.

# Chart

Draw charts with matplotlib's API, without Python. The agent writes the chart as a list of matplotlib calls, the `chart_render` tool renders it with [mpljs](https://github.com/ivarvong/mpl) (a pure-JavaScript reproduction of matplotlib's output by Ivar Vong), saves the image, and shows it to the agent so it can check what it drew.

Everything runs in-process: no Python, no browser, no network service.

## Load

From the repository root, `pi -e ./packages/chart` for one run, or `pi install ./packages/chart` to keep it. Requires Node 22.18 or newer. No configuration.

## Use

Ask the agent, for example: “Chart last month's p50, p95 and p99 latency with our 250 ms SLO, and a bar chart of p95 by service beside it.”

Charts are saved to `~/.pi/agent/charts/<date>/<name>.png` (or `.svg`); nothing is written into your projects.

## The tool

`chart_render` takes one list of matplotlib calls per panel. Each call is `["method", ...args]`, with keyword arguments as a final object:

```json
{
  "name": "Request latency",
  "style": "pro-dark",
  "cols": 2,
  "width_ratios": [2.2, 1],
  "axes": [
    [
      ["plot", [{ "$date": "2026-10-01" }, { "$date": "2026-10-02" }], [42, 47], { "label": "p50" }],
      ["axhline", 250, { "color": "#ed8796", "ls": "--", "label": "SLO" }],
      ["legend", { "loc": "upper left" }],
      ["set_title", "Request latency"]
    ],
    [["barh", ["api", "db"], [118, 210], { "color": ["C0", "C4"] }]]
  ],
  "figure": [["autofmt_xdate"]]
}
```

- **Panels** can call: plot, scatter, bar, barh, hist, step, fill_between, errorbar, boxplot, imshow, axhline, axvline, axhspan, axvspan, axline, hlines, vlines, text, annotate, legend, grid, the `set_*` title, label, limit, scale and tick methods, tick_params, invert_xaxis, invert_yaxis and set_aspect.
- **The figure** can call suptitle, supxlabel, supylabel, text, autofmt_xdate and subplots_adjust.
- **Dates** are written `{"$date": "2026-10-19"}`.
- **Layout:** `rows`, `cols`, `width_ratios`, `height_ratios`, `sharex`, `sharey`.
- **Size:** `figsize` in inches (default 8 × 4.5) and `dpi` (default 150), up to 4000 × 4000 pixels.
- **Styles:** `pro-slate` (default), `pro-dark`, `pro-ember` and `pro-mono`. `C0`–`C9` follow the style's palette.
- **Output:** `format` is `png` (default; shown to the agent) or `svg` (saved only).

Only the listed matplotlib methods can be called, so a spec can draw but cannot run code, read files or reach the network. A chart is limited to 12 panels and 200,000 values.

## Vendored mpljs

mpljs is not published to npm, and building it from GitHub needs Node 24. Its built JavaScript is therefore kept in `vendor/mpl`, with its ISC license and the font notices in `vendor/mpl/THIRD_PARTY_NOTICES.md`. `vendor/mpl/VENDORED.md` names the commit and how to refresh it.

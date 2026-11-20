import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChartError, renderChart, STYLES, type ChartSpec } from './render.ts';

/** A file name from the chart's name: lowercase words joined by hyphens. */
export const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chart';

const call = Type.Array(Type.Unknown(), {
  minItems: 1,
  description: 'One matplotlib call: ["method", ...args]. A trailing object holds keyword arguments, e.g. ["plot", x, y, {"label": "p95", "color": "C3"}].',
});

const DESCRIPTION = `Draw a chart as an image, with matplotlib's API (rendered by mpljs, a pure-JavaScript matplotlib; no Python needed). Returns the image so you can check it, and saves it under ${'~/.pi/agent/charts'}.
Write the chart as matplotlib calls per panel, as you would in Python:
- axes: one list of calls per panel, row by row. Each call is ["method", ...args], with keyword arguments as a final object.
  Panel methods: plot, scatter, bar, barh, hist, step, fill_between, errorbar, boxplot, imshow, axhline, axvline, axhspan, axvspan, axline, hlines, vlines, text, annotate, legend, grid, set_title, set_xlabel, set_ylabel, set_xlim, set_ylim, set_xscale, set_yscale, set_xticks, set_yticks, set_xticklabels, set_yticklabels, tick_params, invert_xaxis, invert_yaxis, set_aspect.
- figure: calls on the whole figure: suptitle, supxlabel, supylabel, text, autofmt_xdate, subplots_adjust.
- Dates: write {"$date": "2026-10-19"} wherever matplotlib would take a datetime.
- Colours: "C0"…"C9" follow the style's palette; hex works too. Styles: ${STYLES.join(', ')} (pro-dark for dark backgrounds).
Example: {"name": "Request latency", "cols": 2, "width_ratios": [2.2, 1], "axes": [[["plot", [1,2,3], [40,42,39], {"label": "p50"}], ["legend"], ["set_title", "Latency"]], [["barh", ["api","db"], [118,210]]]]}
Compute the data first (in code if you need to); pass numbers, not formulas. Look at the returned image before describing it.`;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'chart',
    label: 'Chart',
    description: DESCRIPTION,
    parameters: Type.Object(
      {
        name: Type.String({ description: 'Short title; also the file name.', minLength: 1, maxLength: 80 }),
        axes: Type.Array(Type.Array(call), { minItems: 1, maxItems: 12, description: 'One list of calls per panel, row by row.' }),
        figure: Type.Optional(Type.Array(call, { description: 'Calls on the whole figure.' })),
        rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
        cols: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: 'Default: enough for every panel in one row.' })),
        width_ratios: Type.Optional(Type.Array(Type.Number({ exclusiveMinimum: 0 }))),
        height_ratios: Type.Optional(Type.Array(Type.Number({ exclusiveMinimum: 0 }))),
        sharex: Type.Optional(Type.Boolean()),
        sharey: Type.Optional(Type.Boolean()),
        style: Type.Optional(Type.Union(STYLES.map((style) => Type.Literal(style)), { description: 'Default pro-slate.' })),
        figsize: Type.Optional(Type.Tuple([Type.Number(), Type.Number()], { description: 'Inches, default [8, 4.5].' })),
        dpi: Type.Optional(Type.Integer({ minimum: 50, maximum: 300, description: 'Default 150.' })),
        format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('svg')], { description: 'Default png. SVG is saved but not shown to you.' })),
      },
      { additionalProperties: false },
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params) {
      try {
        const chart = await renderChart(params as ChartSpec);
        const day = new Date().toISOString().slice(0, 10),
          folder = join(getAgentDir(), 'charts', day),
          path = join(folder, `${slug(params.name)}.${chart.format}`);
        await mkdir(folder, { recursive: true });
        await writeFile(path, chart.data);
        const text = `Saved ${chart.width}×${chart.height} ${chart.format.toUpperCase()} to ${path}`;
        return {
          content: [
            { type: 'text' as const, text },
            ...(chart.format === 'png'
              ? [{ type: 'image' as const, data: Buffer.from(chart.data).toString('base64'), mimeType: 'image/png' }]
              : []),
          ],
          details: { path, width: chart.width, height: chart.height, format: chart.format },
        };
      } catch (error) {
        if (error instanceof ChartError) return { content: [{ type: 'text' as const, text: `Chart not drawn: ${error.message}` }], isError: true, details: {} };
        throw error;
      }
    },
  });
}

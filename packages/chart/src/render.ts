/**
 * Render a chart from a JSON spec with mpljs, a pure-JavaScript port of matplotlib (vendored in ../vendor/mpl).
 * The spec is a list of matplotlib calls per panel, so an agent writes what it already knows from matplotlib,
 * and nothing it sends can run code: each call is a public method on a Figure or Axes, looked up by name.
 */
import { registerFonts, subplots } from '../vendor/mpl/index.js';

export const STYLES = ['pro-slate', 'pro-dark', 'pro-ember', 'pro-mono'] as const;
export type Style = (typeof STYLES)[number];
/** One matplotlib call: the method name, then its arguments. A trailing object is matplotlib's keyword arguments. */
export type Call = [string, ...unknown[]];
export interface ChartSpec {
  name: string;
  style?: Style;
  /** Inches, as matplotlib's figure.figsize. Default [8, 4.5]. */
  figsize?: [number, number];
  /** Pixels per inch. Default 150. */
  dpi?: number;
  rows?: number;
  cols?: number;
  width_ratios?: number[];
  height_ratios?: number[];
  sharex?: boolean;
  sharey?: boolean;
  /** One list of calls per panel, row by row. */
  axes: Call[][];
  /** Calls on the figure itself, such as ["suptitle", "…"] or ["autofmt_xdate"]. */
  figure?: Call[];
  format?: 'png' | 'svg';
}
export interface Rendered {
  format: 'png' | 'svg';
  data: Uint8Array | string;
  width: number;
  height: number;
}
export class ChartError extends Error {}

/** The matplotlib methods a spec may call. mpljs also has internal helpers; those are not reachable. */
export const AXES_METHODS = new Set(
  (
    'annotate axhline axhspan axline axvline axvspan bar barh boxplot errorbar fill_between grid hist hlines ' +
    'imshow invert_xaxis invert_yaxis legend plot scatter set_aspect set_box_aspect set_title set_xlabel set_xlim ' +
    'set_xscale set_xticklabels set_xticks set_xinverted set_ylabel set_ylim set_yscale set_yticklabels set_yticks ' +
    'set_yinverted step text tick_params vlines'
  ).split(' '),
);
export const FIGURE_METHODS = new Set('autofmt_xdate subplots_adjust suptitle supxlabel supylabel text'.split(' '));
const MAX_POINTS = 200_000;

let fontsReady: Promise<void> | undefined;
/** The bundled faces (Inter and DejaVu) load once, on the first chart. */
function loadFonts() {
  fontsReady ??= import('../vendor/mpl/fonts/all.js').then(({ allFonts }) => {
    registerFonts(...(Array.isArray(allFonts) ? allFonts : Object.values(allFonts)));
  });
  return fontsReady;
}

/** {"$date": "2026-10-19"} becomes a Date, anywhere in the arguments; dates are plain JSON otherwise. */
export function revive(value: unknown, budget = { points: 0 }): unknown {
  if (Array.isArray(value)) {
    budget.points += value.length;
    if (budget.points > MAX_POINTS) throw new ChartError(`Too much data: keep a chart under ${MAX_POINTS} values.`);
    return value.map((item) => revive(item, budget));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0]?.[0] === '$date') {
      const date = new Date(String(entries[0][1]));
      if (Number.isNaN(date.getTime())) throw new ChartError(`Not a date: ${JSON.stringify(entries[0][1])}.`);
      return date;
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, revive(item, budget)]));
  }
  return value;
}

function call(
  target: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  [method, ...args]: Call,
  budget: { points: number },
) {
  if (typeof method !== 'string' || !allowed.has(method))
    throw new ChartError(`${where}: "${String(method)}" is not available. Use one of: ${[...allowed].join(', ')}.`);
  const fn = target[method];
  if (typeof fn !== 'function') throw new ChartError(`${where}: there is no "${method}" here.`);
  try {
    fn.apply(target, args.map((arg) => revive(arg, budget)));
  } catch (error) {
    if (error instanceof ChartError) throw error;
    throw new ChartError(`${where} (${method}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function renderChart(spec: ChartSpec): Promise<Rendered> {
  const rows = spec.rows ?? 1,
    cols = spec.cols ?? Math.max(1, Math.ceil((spec.axes?.length ?? 1) / rows));
  if (!Array.isArray(spec.axes) || spec.axes.length === 0) throw new ChartError('Give at least one panel in axes.');
  if (rows * cols > 12) throw new ChartError('Keep a chart to 12 panels or fewer.');
  if (spec.axes.length > rows * cols)
    throw new ChartError(`axes has ${spec.axes.length} panels but the grid has ${rows * cols} (${rows}×${cols}).`);
  if (spec.style !== undefined && !STYLES.includes(spec.style))
    throw new ChartError(`Unknown style "${spec.style}". Use one of ${STYLES.join(', ')}.`);
  const [w, h] = spec.figsize ?? [8, 4.5],
    dpi = spec.dpi ?? 150;
  if (!(w > 0 && h > 0 && w * dpi <= 4000 && h * dpi <= 4000))
    throw new ChartError('Keep the image within 4000×4000 pixels (figsize × dpi).');
  await loadFonts();
  const gridspec_kw: Record<string, unknown> = {};
  if (spec.width_ratios) gridspec_kw.width_ratios = spec.width_ratios;
  if (spec.height_ratios) gridspec_kw.height_ratios = spec.height_ratios;
  let fig: any, grid: any;
  try {
    [fig, grid] = subplots(rows, cols, {
      style: spec.style ?? 'pro-slate',
      rc: { 'figure.figsize': [w, h], 'figure.dpi': dpi },
      ...(spec.sharex ? { sharex: true } : {}),
      ...(spec.sharey ? { sharey: true } : {}),
      ...(Object.keys(gridspec_kw).length ? { gridspec_kw } : {}),
    });
  } catch (error) {
    throw new ChartError(`Layout: ${error instanceof Error ? error.message : String(error)}`);
  }
  const panels: any[] = rows * cols === 1 ? [grid] : (grid as any[]).flat();
  const budget = { points: 0 };
  spec.axes.forEach((calls, panel) =>
    (calls ?? []).forEach((item, index) => call(panels[panel], AXES_METHODS, `axes[${panel}][${index}]`, item, budget)),
  );
  (spec.figure ?? []).forEach((item, index) => call(fig, FIGURE_METHODS, `figure[${index}]`, item, budget));
  fig.tight_layout();
  const width = Math.round(w * dpi),
    height = Math.round(h * dpi);
  return spec.format === 'svg'
    ? { format: 'svg', data: fig.toSVG(), width, height }
    : { format: 'png', data: fig.toPNGSync(), width, height };
}

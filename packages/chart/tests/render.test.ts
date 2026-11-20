import assert from 'node:assert/strict';
import test from 'node:test';
import { ChartError, renderChart, revive } from '../src/render.ts';
import { slug } from '../src/index.ts';

const PNG = [0x89, 0x50, 0x4e, 0x47];

test('a two-panel chart with dates renders to a PNG of the requested size', async () => {
  const days = Array.from({ length: 10 }, (_, i) => ({ $date: `2026-10-${String(i + 1).padStart(2, '0')}` }));
  const chart = await renderChart({
    name: 'Latency',
    style: 'pro-dark',
    figsize: [9, 4.2],
    dpi: 100,
    cols: 2,
    width_ratios: [2.2, 1],
    axes: [
      [
        ['fill_between', days, days.map(() => 30), days.map(() => 50), { alpha: 0.2, color: 'C0' }],
        ['plot', days, days.map((_, i) => 40 + i), { label: 'p50' }],
        ['axhline', 55, { color: '#ed8796', ls: '--', label: 'SLO' }],
        ['legend', { loc: 'upper left' }],
        ['set_title', 'Request latency'],
      ],
      [['barh', ['api', 'db', 'cache'], [118, 210, 12], { color: ['C0', 'C4', 'C2'] }], ['set_title', 'By service']],
    ],
    figure: [['autofmt_xdate']],
  });
  assert.equal(chart.format, 'png');
  assert.deepEqual([...(chart.data as Uint8Array).slice(0, 4)], PNG);
  assert.deepEqual([chart.width, chart.height], [900, 420]);
});

test('SVG output is text', async () => {
  const chart = await renderChart({ name: 'x', format: 'svg', axes: [[['plot', [1, 2, 3], [3, 1, 2]]]] });
  assert.match(String(chart.data), /<svg/);
});

test('only matplotlib drawing methods can be called', async () => {
  for (const method of ['toPNGSync', 'paint', 'constructor', '__proto__', 'savefig'])
    await assert.rejects(renderChart({ name: 'x', axes: [[[method]]] }), ChartError);
  await assert.rejects(renderChart({ name: 'x', axes: [[['plot', [1]]]], figure: [['toSVG']] }), /not available/);
});

test('errors name the panel and call', async () => {
  await assert.rejects(
    renderChart({ name: 'x', axes: [[['plot', [1, 2], [1, 2]]], [['set_xlim', 'a', 'b', 'c', 'd']]] }),
    (error: Error) => error instanceof ChartError && /axes\[1\]/.test(error.message),
  );
});

test('limits: grid size, image size, style, data volume, bad dates', async () => {
  await assert.rejects(renderChart({ name: 'x', axes: [[], [], []], rows: 1, cols: 2 }), /grid has 2/);
  await assert.rejects(renderChart({ name: 'x', axes: [[]], figsize: [100, 100] }), /4000/);
  await assert.rejects(renderChart({ name: 'x', axes: [[]], style: 'neon' as never }), /Unknown style/);
  assert.throws(() => revive(new Array(200_001).fill(0)), /Too much data/);
  assert.throws(() => revive({ $date: 'soon' }), /Not a date/);
  assert.ok(revive({ $date: '2026-10-19' }) instanceof Date);
});

test('file names come from the chart name', () => {
  assert.equal(slug('Request latency, October'), 'request-latency-october');
  assert.equal(slug('!!!'), 'chart');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/core.ts';
const width = text => text.length;
const truncate = (text, size) => text.slice(0, Math.max(0, size));

test('bar uses one inter-pill space and no inner bracket padding', () => {
  const result = layout([{label:'Map and Account Plan'}], 100, width, truncate, true);
  assert.equal(result.lines[0], '[+] [Map and Account Plan (+)(d)]');
  for (const region of result.regions) {
    const text = result.lines[region.y].slice(region.x, region.x + region.width);
    if (region.action === 'diff') assert.equal(text, '(d)');
    if (region.action === 'panel' && region.width === 3) assert(['[+]', '(+)'].includes(text));
  }
  const noDiff = layout([{label:'Map'}], 100, width, truncate);
  assert.equal(noDiff.lines[0], '[+] [Map (+)]');
});

test('wrapping starts each pill at column zero without extra gaps', () => {
  const result = layout([{label:'One'}, {label:'Two'}], 10, width, truncate);
  assert.deepEqual(result.lines, ['[+]', '[One (+)]', '[Two (+)]']);
  assert(result.blocks.every(block => block.x === 0));
});

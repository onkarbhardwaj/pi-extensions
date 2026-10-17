import test from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../src/core.ts';
const width = text => text.length;
const truncate = (text, size) => text.slice(0, Math.max(0, size));

test('bar uses one inter-pill space and no inner bracket padding', () => {
  const result = layout([{label:'Quarterly planning'}, {label:'Notes'}], 100, width, truncate);
  assert.equal(result.lines[0], '📎 [Quarterly planning] [Notes]');
});

test('wrapping starts each pill at column zero without extra gaps', () => {
  const result = layout([{label:'One'}, {label:'Two'}], 7, width, truncate);
  assert.deepEqual(result.lines, ['📎', '[One]', '[Two]']);
  assert(result.blocks.every(block => block.x === 0));
});

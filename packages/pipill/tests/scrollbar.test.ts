import test from 'node:test';
import assert from 'node:assert/strict';
import { pageToward, scrollbar } from '../src/scrollbar.ts';

const thumb = (bar?: boolean[]) => bar?.map(on => (on ? '█' : '·')).join('');

test('no scrollbar when the content fits', () => {
  assert.equal(scrollbar(10, 10, 0), undefined);
  assert.equal(scrollbar(10, 3, 0), undefined);
});

test('the thumb shows the visible share and reaches the ends exactly at the top and bottom', () => {
  assert.equal(thumb(scrollbar(10, 20, 0)), '█████·····');
  assert.equal(thumb(scrollbar(10, 20, 10)), '·····█████');
  assert.equal(thumb(scrollbar(10, 20, 5)), '···█████··');
  assert.equal(thumb(scrollbar(4, 1000, 0)), '█···', 'a long document still gets a one-row thumb');
  assert.equal(thumb(scrollbar(4, 1000, 996)), '···█');
});

test('clicking the track pages toward the click and stops at the ends', () => {
  assert.equal(pageToward(9, 10, 40, 0), 9);
  assert.equal(pageToward(0, 10, 40, 20), 11);
  assert.equal(pageToward(9, 10, 40, 25), 30, 'paging past the end stops at the end');
  assert.equal(pageToward(1, 10, 40, 0), 0, 'a click on the thumb does nothing');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_TYPE } from '../src/core.ts';
const available = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].every(name => {
  try { import.meta.resolve(name); return true; } catch { return false; }
});
test('/refs lists session references without reading files or opening a modal', {
  skip: !available && 'Pi peers needed for command test.',
}, async () => {
  const { default: extension } = await import('../src/index.ts');
  const commands = new Map(); let entries = [], notice = '';
  extension({ on() {}, registerCommand: (name, command) => commands.set(name, command), registerTool() {} });
  const ctx = { mode: 'rpc', sessionManager: { getEntries: () => entries }, ui: { notify: text => notice = text } };
  await commands.get('refs').handler('', ctx);
  assert.equal(notice, 'No reference files registered.');
  entries = [{ type: 'custom', customType: STATE_TYPE, data: { version: 1, paths: ['/missing/a.md', '/other/a.md'] } }];
  await commands.get('refs').handler('', ctx);
  assert(notice.includes('a.md (1)')); assert(notice.includes('a.md (2)'));
  assert(notice.includes('/missing/a.md')); assert(notice.includes('/other/a.md'));
});

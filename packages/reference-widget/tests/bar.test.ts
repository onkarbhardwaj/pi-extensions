import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_TYPE } from '../src/core.ts';

const available = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox'].every(name => {
  try { import.meta.resolve(name); return true; } catch { return false; }
});

test('truncated reference names and overflow controls retain accent colour', {
  skip: !available && 'Pi peer dependencies are needed for the widget test.',
}, async () => {
  const { default: extension } = await import('../src/index.ts');
  const { visibleWidth } = await import('@earendil-works/pi-tui');
  const handlers = new Map(); let widget;
  extension({ on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerTool() {} });
  const ctx = {
    mode: 'tui',
    sessionManager: { getEntries: () => [{ type: 'custom', customType: STATE_TYPE, data: {
      version: 1, paths: ['/access-map-and-account-plan 1.md', '/Marigolds_Alumis_Master_Payer_Table_2026-09-21 1.md'],
    } }] },
    ui: { setWidget: (_name, factory) => widget = factory({}, {
      fg: (_color, text) => '\x1b[35m' + text + '\x1b[0m',
    }) },
  };
  await handlers.get('session_start')({}, ctx);
  for (const width of [8, 30, 60, 100]) {
    const line = widget.render(width)[0];
    assert(visibleWidth(line) <= width);
    let accent = false;
    for (let i = 0; i < line.length;) {
      if (line[i] === '\x1b') {
        const code = /^\x1b\[(\d+)m/.exec(line.slice(i));
        assert(code); accent = code[1] === '35'; i += code[0].length;
      } else {
        assert(accent, `Unstyled character after truncation at width ${width}`); i++;
      }
    }
  }
});

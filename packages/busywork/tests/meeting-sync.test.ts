import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'busywork-sync-'));
const calendar = join(dir, 'calendar.json');
const helper = join(dir, 'meetings');
await writeFile(helper, `#!/bin/sh\ncat '${calendar}'\n`);
await chmod(helper, 0o755);
await writeFile(join(dir, 'busywork.json'), JSON.stringify({ meetings: { command: helper } }));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: busywork } = await import('../src/index.ts');

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    appendEntry: () => {},
    sendUserMessage: () => {},
  };
  return { pi, handlers, tools };
}

const newContext = () => ({ mode: 'tui', ui: { notify: () => {}, setWidget: () => {} }, sessionManager: { getEntries: () => [] } });
const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const meeting = (id: string, title: string) => ({ id, title, start: inTwoHours(), end: inTwoHours(), status: 'accepted', canceled: false });

async function reminderTitles(reminder: any, expected: number) {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const listed = await reminder.execute('call', { action: 'list' }, undefined, undefined, newContext());
    const titles = listed.details.reminders.map((r: any) => r.text.split(' at ')[0]);
    if (titles.length >= expected || performance.now() > deadline) return titles;
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('meeting sync keeps running after reminders are used from another context', async () => {
  const { pi, handlers, tools } = fakePi();
  await busywork(pi as any);
  mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  try {
    await writeFile(calendar, JSON.stringify([meeting('planning', 'Planning')]));
    handlers.get('session_start')!({}, newContext());
    const reminder = tools.get('reminder');
    assert.deepEqual(await reminderTitles(reminder, 1), ['📅 Planning']);

    await writeFile(calendar, JSON.stringify([meeting('planning', 'Planning'), meeting('standup', 'Stand Up')]));
    mock.timers.tick(15 * 60_000);
    assert.deepEqual(await reminderTitles(reminder, 2), ['📅 Planning', '📅 Stand Up']);
  } finally {
    handlers.get('session_shutdown')!({}, newContext());
    mock.timers.reset();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pi hands every event a new context object for the same session. The timeline must still run.
test('agent_settled with a fresh context object for the same session writes a timeline update', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pipill-trigger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, path: process.env.PATH };
  t.after(() => { process.env.PI_CODING_AGENT_DIR = saved.agentDir; process.env.PATH = saved.path; });
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PATH = `${dir}:${saved.path}`;
  await writeFile(join(dir, 'pipill.json'), JSON.stringify({ timeline: { enabled: true, minMessages: 2, timeoutSeconds: 10 } }));
  await writeFile(join(dir, 'pi'), '#!/bin/sh\ncat >/dev/null\necho \'{"updates": {"alpha": "Shipped the first draft."}, "recent": [{"text": "Drafted alpha.", "topic": "alpha"}]}\'\n');
  await chmod(join(dir, 'pi'), 0o755);

  const { default: extension } = await import('../src/index.ts');
  const handlers: Record<string, any> = {}, tools: Record<string, any> = {}, entries: any[] = [];
  const pi: any = { on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand() {}, registerTool: (tool: any) => { tools[tool.name] = tool; },
    appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data }), events: { on() {}, emit() {} } };
  await extension(pi);
  const branch = [
    { type: 'message', id: 'm1', message: { role: 'user', content: 'Let us draft alpha.' } },
    { type: 'message', id: 'm2', message: { role: 'assistant', content: [{ type: 'text', text: 'Drafted alpha.' }] } },
  ];
  const context = (): any => ({ mode: 'print', cwd: dir, ui: { notify() {}, setWidget() {} },
    sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionId: () => 'session-1', getSessionFile: () => 'file' } });
  handlers.session_start({}, context());
  await tools.pipill.execute('1', { action: 'add', label: 'alpha' }, undefined, undefined, context());
  handlers.agent_settled({}, context());
  for (let i = 0; i < 50 && !entries.some(e => e.customType === 'pi-pill-timeline'); i++) await new Promise(r => setTimeout(r, 100));
  const timeline = entries.findLast(e => e.customType === 'pi-pill-timeline');
  assert.deepEqual(timeline?.data, { version: 1, cursor: 'm2', timelines: { alpha: ['Shipped the first draft.'] },
    recent: [{ text: 'Drafted alpha.', topic: 'alpha' }], dismissed: [] });
  handlers.session_shutdown?.({}, context());
});

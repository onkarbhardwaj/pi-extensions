import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'canvas-lifecycle-'));
const { default: canvas } = await import('../src/index.ts');

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
    events: { on: () => {}, emit: () => {} },
  };
  return { pi, handlers };
}

test('a chip refresh still pending when the session ends does not touch the ended session', async () => {
  const { pi, handlers } = fakePi();
  canvas(pi as any);
  const statuses: unknown[] = [];
  const ctx = { cwd: process.cwd(), ui: { setStatus: (_id: string, label: unknown) => statuses.push(label), notify: () => {} } };
  await handlers.get('session_start')!({}, ctx);
  statuses.length = 0;

  // As under `pi -p`: the agent settles and the session shuts down before the refresh's reads finish.
  handlers.get('agent_settled')!({});
  await handlers.get('session_shutdown')!({});
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.deepEqual(statuses, [undefined], 'only the shutdown clears the status; the stale refresh draws nothing');
});

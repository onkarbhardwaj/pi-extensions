/**
 * A small Chrome DevTools Protocol client over the browser's WebSocket (Node 22 has WebSocket built in).
 * Screenshots use a separate, disposable browser context, so the person's tabs, cookies and logins are
 * never touched; nothing here closes the browser.
 */

import { CanvasError } from './core.ts';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Cdp {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(m: any) => void>();

  static async connect(endpoint: string, timeoutMs = 5000) {
    let info: any;
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
      info = await response.json();
    } catch { throw new CanvasError(`No browser answers at ${endpoint}. Check browser.cdp in ~/.pi/agent/canvas.json.`); }
    const url = info?.webSocketDebuggerUrl;
    if (typeof url !== 'string') throw new CanvasError(`${endpoint} did not give a DevTools address.`);
    const cdp = new Cdp();
    cdp.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CanvasError('Timed out connecting to the browser.')), timeoutMs);
      cdp.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      cdp.ws.addEventListener('error', () => { clearTimeout(timer); reject(new CanvasError('Could not connect to the browser.')); }, { once: true });
    });
    cdp.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const p = cdp.pending.get(message.id); if (!p) return;
        cdp.pending.delete(message.id);
        if (message.error) p.reject(new CanvasError(`Browser: ${message.error.message}`)); else p.resolve(message.result);
      } else for (const l of cdp.listeners) l(message);
    });
    cdp.ws.addEventListener('close', () => { for (const p of cdp.pending.values()) p.reject(new CanvasError('Browser connection closed.')); cdp.pending.clear(); });
    return cdp;
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CanvasError(`Browser did not answer ${method}.`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method: string, sessionId: string, timeoutMs: number) {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.listeners.delete(listener); resolve(); }, timeoutMs);
      const listener = (m: any) => { if (m.method === method && m.sessionId === sessionId) { clearTimeout(timer); this.listeners.delete(listener); resolve(); } };
      this.listeners.add(listener);
    });
  }

  /** Disconnect only; the browser keeps running. */
  close() { try { this.ws.close(); } catch {} }
}

/** A PNG of the page at the given size, from a disposable context in the configured browser. */
export async function screenshot(endpoint: string, url: string, width: number, height: number): Promise<Buffer> {
  const cdp = await Cdp.connect(endpoint);
  let browserContextId: string | undefined;
  try {
    ({ browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true }));
    // A separate context opens its own window in a windowed browser; it is closed as soon as the shot is taken.
    // (A hidden target would not show at all, but hidden pages never paint, so they cannot be captured.)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId, width, height, background: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    // Background pages may not paint unless they believe they have focus.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const loaded = cdp.waitFor('Page.loadEventFired', sessionId, 15_000);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    await new Promise(r => setTimeout(r, 400));
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
    return Buffer.from(data, 'base64');
  } finally {
    if (browserContextId) await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    cdp.close();
  }
}

/** Bring the canvas up in the person's browser: reuse its tab if one is open, otherwise open one. */
export async function show(endpoint: string, canvasUrl: string, fit: string[] = []) {
  const cdp = await Cdp.connect(endpoint);
  try {
    const target = `${canvasUrl}${fit.length ? `#fit=${fit.map(encodeURIComponent).join(',')}` : ''}`;
    const { targetInfos } = await cdp.send('Target.getTargets');
    const tab = (targetInfos as any[]).find(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(canvasUrl));
    if (tab) {
      await cdp.send('Target.activateTarget', { targetId: tab.targetId });
      if (fit.length) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
        await cdp.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(`fit=${fit.map(encodeURIComponent).join(',')}`)}` }, sessionId);
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
      return { opened: false };
    }
    await cdp.send('Target.createTarget', { url: target });
    return { opened: true };
  } finally { cdp.close(); }
}

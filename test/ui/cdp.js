'use strict';
/** Minimal Chrome DevTools Protocol client (flattened sessions) using Node's global WebSocket. */

class Cdp {
  static async connect(port, match) {
    let target = null;
    for (let i = 0; i < 120 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && match(t));
      } catch (_) { /* not up yet */ }
      if (!target) await new Promise((r) => setTimeout(r, 500));
    }
    if (!target) throw new Error('workbench page target not found');
    const c = new Cdp(target.webSocketDebuggerUrl);
    await c.open;
    return c;
  }

  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws = new WebSocket(url);
    this.open = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message}`)); else resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(fn) { this.handlers.push(fn); }

  close() { try { this.ws.close(); } catch (_) { /* ignore */ } }
}

module.exports = { Cdp };

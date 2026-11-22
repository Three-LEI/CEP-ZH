// Minimal Chrome DevTools Protocol client for CEP panels.
// No dependencies: Node 18 (custom WebSocket fallback) / Node 22+ (global WebSocket).
import { createWebSocket } from './ws.mjs';

export async function listTargets(port, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function connect(wsUrl) {
  const ws = createWebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WebSocket error')); };
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  ws.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('WebSocket closed'));
    pending.clear();
  };
  return {
    ws,
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(fn) { listeners.add(fn); },
    close() { ws.close(); },
  };
}

export async function evaluate(client, expression, { awaitPromise = true } = {}) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

// CLI: node cdp.mjs <port> [expression|@file]
if (process.argv[1] && process.argv[1].endsWith('cdp.mjs')) {
  const port = process.argv[2];
  const arg = process.argv[3] || 'document.title';
  const fs = await import('node:fs');
  const expression = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;
  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + port);
  const client = await connect(page.webSocketDebuggerUrl);
  const value = await evaluate(client, expression);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  client.close();
}

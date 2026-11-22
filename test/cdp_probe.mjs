// Minimal CDP probe: connect to a CEP panel's DevTools endpoint and inspect its DOM.
const port = process.argv[2] || '8033';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
console.log('targets:', targets.map(t => `${t.type} ${t.title} ${t.url}`));

const target = targets.find(t => t.type === 'page');
if (!target) throw new Error('no page target');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const info = await evaluate(`JSON.stringify({
  title: document.title,
  href: location.href,
  text: (document.body ? document.body.innerText : '').slice(0, 400),
  textNodes: (() => { let n = 0; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) n++; return n; })(),
  elements: document.querySelectorAll('*').length,
  hasAngular: typeof angular !== 'undefined',
  cep: typeof window.__adobe_cep__,
  keys: Object.keys(window).filter(k => /cep|adobe|CSInterface|Vulcan/i.test(k)).slice(0, 20)
})`);
console.log(JSON.parse(info));

// prove we can mutate the live page
await evaluate(`window.__cep_zh_probe = 'ok'; document.title = 'Overlord [probe]';`);
const after = await evaluate(`JSON.stringify({ mark: window.__cep_zh_probe, title: document.title })`);
console.log('after mutation:', after);
ws.close();

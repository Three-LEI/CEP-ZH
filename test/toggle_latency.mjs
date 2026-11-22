import { listTargets, connect, evaluate } from '../tools/cep-zh/lib/cdp.mjs';

const managerPort = Number(process.argv[2]);
const panelPort = Number(process.argv[3]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(port) {
  const targets = await listTargets(port);
  const p = targets.find((t) => t.type === 'page');
  if (!p) throw new Error('no page on ' + port);
  return connect(p.webSocketDebuggerUrl);
}

async function waitEnabled(client, want, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await evaluate(client, '!!(window.__CEP_ZH__ && window.__CEP_ZH__.stats && window.__CEP_ZH__.stats().enabled)');
    if (v === want) return Date.now() - t0;
    await sleep(25);
  }
  return -1;
}

const m = await page(managerPort);
const p = await page(panelPort);

await evaluate(m, "(() => { const t=document.getElementById('globalToggle'); t.checked=false; t.dispatchEvent(new Event('change')); return Date.now(); })()");
const off = await waitEnabled(p, false);
console.log('off_ms', off);

await evaluate(m, "(() => { const t=document.getElementById('globalToggle'); t.checked=true; t.dispatchEvent(new Event('change')); return Date.now(); })()");
const on = await waitEnabled(p, true);
console.log('on_ms', on);

m.close();
p.close();

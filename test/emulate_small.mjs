import fs from 'node:fs';
import { listTargets, connect, evaluate } from '../tools/cep-zh/lib/cdp.mjs';

const port = Number(process.argv[2]);
const out = process.argv[3];
const targets = await listTargets(port);
const page = targets.find((t) => t.type === 'page');
const c = await connect(page.webSocketDebuggerUrl);
await c.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 600, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 300));
console.log(await evaluate(c, "JSON.stringify({root:getComputedStyle(document.documentElement).fontSize, body:getComputedStyle(document.body).fontSize, view:[innerWidth,innerHeight], overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})"));
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
await c.send('Emulation.clearDeviceMetricsOverride');
c.close();

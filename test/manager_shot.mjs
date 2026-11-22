import fs from 'node:fs';
import { listTargets, connect } from '../tools/cep-zh/lib/cdp.mjs';

const port = process.argv[2];
const out = process.argv[3];
const targets = await listTargets(port);
const page = targets.find((t) => t.type === 'page');
const c = await connect(page.webSocketDebuggerUrl);
const shot = await c.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out, fs.statSync(out).size);
c.close();

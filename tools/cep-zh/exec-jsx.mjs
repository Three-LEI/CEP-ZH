// Run an ExtendScript (.jsx) in the host application through any CEP panel's evalScript bridge.
// Usage: node exec-jsx.mjs <panelDebugPort> <script.jsx>
import fs from 'node:fs';
import { listTargets, connect, evaluate } from './lib/cdp.mjs';

const [port, jsxPath] = process.argv.slice(2);
if (!port || !jsxPath) {
  console.error('usage: node exec-jsx.mjs <panelDebugPort> <script.jsx>');
  process.exit(2);
}
const jsx = fs.readFileSync(jsxPath, 'utf8');
const targets = await listTargets(port);
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target on port ' + port);
const client = await connect(page.webSocketDebuggerUrl);
const expression = `new Promise((resolve) => { window.__adobe_cep__.evalScript(${JSON.stringify(jsx)}, resolve); })`;
try {
  const result = await evaluate(client, expression);
  console.log(result);
} finally {
  client.close();
}


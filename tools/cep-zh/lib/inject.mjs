// Build and inject the cep-zh runtime over Chrome DevTools Protocol.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listTargets, connect, evaluate } from './cdp.mjs';

const RUNTIME_URL = new URL('../runtime/runtime.js', import.meta.url);
export const RUNTIME_SOURCE = fs.readFileSync(fileURLToPath(RUNTIME_URL), 'utf8');

export function buildSource(config) {
  return (
    '/* cep-zh ' + (config.version || '1.0.0') + ' -> ' + (config.bundleId || config.extId || config.port) + ' */\n' +
    ';(function(){try{if(window.__CEP_ZH__&&window.__CEP_ZH__.off)window.__CEP_ZH__.off();}catch(e){}window.__CEP_ZH__=null;})();\n' +
    'window.__CEP_ZH_CONFIG__ = ' + JSON.stringify(config) + ';\n' +
    RUNTIME_SOURCE
  );
}

/**
 * Attach to a panel and inject the translation runtime.
 * @returns {Promise<{client, page, source, identifier, config, stats}>}
 */
export async function attach(port, config, { timeout = 900 } = {}) {
  const targets = await listTargets(port, timeout);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + port);
  const client = await connect(page.webSocketDebuggerUrl);
  let identifier = null;
  try {
    await client.send('Page.enable');
  } catch { /* older CEP builds may not implement Page.enable */ }
  await enableActivityBinding(client);

  const source = buildSource(config);
  try {
    const r = await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    identifier = r.identifier || null;
  } catch { /* ignore: we can still evaluate into the current document */ }

  await evaluate(client, source);
  const stats = await readStats(client);
  return { port, client, page, source, identifier, config, stats };
}

/**
 * Install the Runtime binding the runtime uses to push activity hints. When the
 * host rejects it, everything still works via the Agent's 1 s stats polling.
 */
export async function enableActivityBinding(client) {
  try {
    await client.send('Runtime.enable');
  } catch { /* legacy host */ }
  try {
    await client.send('Runtime.addBinding', { name: '__cepZhActivity' });
    return true;
  } catch {
    return false;
  }
}

export async function readStats(client) {
  try {
    const raw = await evaluate(client, 'window.__CEP_ZH__ ? JSON.stringify(window.__CEP_ZH__.stats()) : null');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function reinject(session, config) {
  const source = buildSource(config);
  if (session.identifier) {
    try { await session.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.identifier }); } catch {}
  }
  try {
    const r = await session.client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    session.identifier = r.identifier || null;
  } catch {}
  await evaluate(session.client, source);
  session.source = source;
  session.config = config;
  session.stats = await readStats(session.client);
  return session.stats;
}

export async function evaluateOn(session, expression) {
  return evaluate(session.client, expression);
}

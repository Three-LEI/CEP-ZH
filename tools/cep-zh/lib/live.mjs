// Map live CEP DevTools ports back to extension bundles, and probe /json endpoints.
import { listCepListeningPorts } from './net.mjs';
import { listTargets } from './cdp.mjs';

export function buildPortIndex(scan) {
  const index = new Map(); // port -> { port, bundle, extId, host }
  for (const bundle of scan.bundles) {
    for (const [extId, hosts] of Object.entries(bundle.debug || {})) {
      for (const [host, port] of Object.entries(hosts)) {
        if (!index.has(port)) index.set(port, { port, bundle, extId, host });
      }
    }
  }
  return index;
}

function normalizePath(p) {
  return p.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
}

export function matchBundleByUrl(scan, url) {
  if (!url) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(url.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''));
  } catch {
    decoded = url;
  }
  if (/^[a-z]+:\/\//i.test(decoded)) return null;
  const target = normalizePath(decoded);
  let best = null;
  for (const bundle of scan.bundles) {
    const base = normalizePath(bundle.basePath).replace(/\\+$/, '');
    if (target === base || target.startsWith(base + '\\')) {
      if (!best || bundle.basePath.length > best.basePath.length) best = bundle;
    }
  }
  return best;
}

/** Prefer the extension whose MainPath matches the panel URL; fall back to the first one. */
export function matchExtensionByUrl(bundle, url) {
  if (!bundle) return null;
  let decoded;
  try {
    decoded = normalizePath(decodeURIComponent(url.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '')));
  } catch {
    decoded = normalizePath(url || '');
  }
  let fallback = null;
  for (const ext of bundle.extensions) {
    if (!ext.mainPathAbs) continue;
    if (!fallback) fallback = ext;
    if (normalizePath(ext.mainPathAbs) === decoded) return ext;
  }
  return fallback || bundle.extensions[0] || null;
}

export function resolveLiveTarget(scan, portIndex, { port, page }) {
  // The URL is authoritative: developer .debug files sometimes share a port
  // (two extensions both claim 8092), so the port map alone can be wrong.
  const bundle = matchBundleByUrl(scan, page?.url);
  if (bundle) {
    const ext = matchExtensionByUrl(bundle, page?.url);
    return { port, bundle, extId: ext?.id || '', host: '' };
  }
  const mapped = portIndex.get(port);
  if (mapped) return mapped;
  return null;
}

/** Probe every loopback port owned by a CEPHtmlEngine process for a DevTools page target. */
export async function discoverLivePanels({ timeout = 700 } = {}) {
  const listeners = listCepListeningPorts();
  const unique = [...new Map(listeners.map((l) => [l.port, l])).values()];
  const found = [];
  await Promise.all(unique.map(async (l) => {
    try {
      const targets = await listTargets(l.port, timeout);
      const page = targets.find((t) => t.type === 'page');
      if (page) found.push({ port: l.port, pid: l.pid, page, targets });
    } catch { /* not a DevTools endpoint (extension-created local servers etc.) */ }
  }));
  found.sort((a, b) => a.port - b.port);
  return found;
}

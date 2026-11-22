// Allocate stable remote-debugging ports for every CEP extension / host pair.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPortFree, listCepListeningPorts } from './net.mjs';

const TOOL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const STATE_PATH = path.join(TOOL_DIR, 'state.json');
export const DEFAULT_START_PORT = 39300;
export const MAX_PORT = 45999;

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { version: 1, startPort: DEFAULT_START_PORT, ports: {}, files: {} };
  }
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

/**
 * @param {{bundle:object, ext:object, hosts:string[]}[]} targets
 * @returns {Promise<{allocations: {bundle:object, ext:object, host:string, port:number, source:string}[], warnings:string[], nextPort:number}>}
 */
export async function allocatePorts(targets, { state, startPort, reserved = [] } = {}) {
  state = state || loadState();
  const warnings = [];
  let next = Number(startPort || state.startPort || DEFAULT_START_PORT);
  const used = new Set(reserved);
  const byExtHost = new Map(); // extId|host -> port

  // Ports already configured by extension developers must be preserved.
  const existing = new Map(); // bundle.basePath|extId|host -> port
  for (const t of targets) {
    const dbg = t.bundle.debug?.[t.ext.id] || {};
    for (const host of t.hosts) {
      if (Number.isInteger(dbg[host])) {
        existing.set(`${t.bundle.basePath}|${t.ext.id}|${host}`, dbg[host]);
        used.add(dbg[host]);
      }
    }
  }

  // Never take a port that is currently listening on this machine.
  for (const { port } of listCepListeningPorts()) used.add(port);

  const allocations = [];
  for (const t of targets) {
    for (const host of t.hosts) {
      const key = `${t.ext.id}|${host}`;
      let port = byExtHost.get(key);
      let source = 'shared';
      if (port === undefined) {
        const own = existing.get(`${t.bundle.basePath}|${t.ext.id}|${host}`);
        if (own !== undefined) {
          port = own;
          source = 'existing';
        } else {
          const preferred = state.ports?.[t.ext.id]?.[host];
          if (Number.isInteger(preferred) && !used.has(preferred) && await isPortFree(preferred)) {
            port = preferred;
            source = 'state';
          } else {
            while (next <= MAX_PORT) {
              const candidate = next++;
              if (used.has(candidate)) continue;
              if (!(await isPortFree(candidate))) continue;
              port = candidate;
              source = 'new';
              break;
            }
            if (port === undefined) throw new Error('no free debug port left in range');
          }
        }
        byExtHost.set(key, port);
        used.add(port);
      }
      allocations.push({ bundle: t.bundle, ext: t.ext, host, port, source });
    }
  }

  // Detect the same extension id / host configured with two different ports.
  const seen = new Map();
  for (const a of allocations) {
    const key = `${a.ext.id}|${a.host}`;
    if (seen.has(key) && seen.get(key) !== a.port) {
      warnings.push(`${a.ext.id} [${a.host}] is configured with ${seen.get(key)} and ${a.port} by different extension folders; keeping both.`);
    }
    seen.set(key, a.port);
  }

  return { allocations, warnings, nextPort: next };
}

export function applyAllocationsToState(state, allocations) {
  const ports = state.ports || (state.ports = {});
  for (const a of allocations) {
    ports[a.ext.id] = ports[a.ext.id] || {};
    ports[a.ext.id][a.host] = a.port;
  }
}

/** Group allocations per extension bundle folder for .debug writing. */
export function groupByBundle(allocations) {
  const map = new Map();
  for (const a of allocations) {
    const key = a.bundle.basePath;
    if (!map.has(key)) map.set(key, { bundle: a.bundle, entries: new Map() });
    const group = map.get(key);
    if (!group.entries.has(a.ext.id)) group.entries.set(a.ext.id, {});
    group.entries.get(a.ext.id)[a.host] = a.port;
  }
  return [...map.values()].map(({ bundle, entries }) => ({
    bundle,
    additions: [...entries.entries()].map(([id, hosts]) => ({ id, hosts })),
  }));
}

export function printAllocationTable(allocations) {
  for (const a of allocations) {
    console.log(
      [a.port, a.host, a.ext.id, a.source, a.bundle.bundleId].join('\t')
    );
  }
}

// Per-extension .debug baseline.
//
// v2 records whether a bundle actually had a .debug file when the baseline was
// written. Legacy path-only baselines are treated as "not known to have debug"
// so extensions that were present before the upgrade can still be repaired.
import fs from 'node:fs';
import path from 'node:path';

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function toMap(doc) {
  const map = new Map();
  if (!doc || typeof doc !== 'object') return null;
  if (doc.bundles && typeof doc.bundles === 'object') {
    for (const [p, v] of Object.entries(doc.bundles)) {
      map.set(norm(p), {
        bundleId: (v && v.bundleId) || '',
        hasDebug: !!(v && v.hasDebug),
      });
    }
    return map;
  }
  if (Array.isArray(doc.paths)) {
    for (const p of doc.paths) map.set(norm(p), { bundleId: '', hasDebug: false });
    return map;
  }
  return null;
}

export function buildDebugBaseline(scan, now = new Date()) {
  const bundles = {};
  for (const bundle of scan?.bundles || []) {
    if (!bundle || !bundle.basePath) continue;
    bundles[norm(bundle.basePath)] = {
      bundleId: bundle.bundleId || '',
      hasDebug: !!bundle.hasDebugFile,
      hosts: (bundle.hosts || []).map((h) => h.name).filter(Boolean),
    };
  }
  return {
    version: 2,
    updatedAt: now.toISOString(),
    paths: Object.keys(bundles).sort(),
    bundles,
  };
}

export function writeDebugBaseline(file, scan) {
  const doc = buildDebugBaseline(scan);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return toMap(doc) || new Map();
}

export function loadDebugBaseline(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return toMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

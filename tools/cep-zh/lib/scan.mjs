// Locate Adobe CEP extension bundles on this machine.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseManifest } from './manifest.mjs';
import { readDebugFile, debugPathFor } from './debugfile.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.vscode', 'Plug-ins', 'Presets', 'Scripts', 'Media',
  'Dictionaries', 'Lumetri', 'MLModels', 'sounds', 'PNG', 'cursors', 'HelpCfg',
  'EngineAssets', 'typesupport', 'usd_plugins', 'ngl', 'pdfl', 'AMT', 'zstring',
  'locale', 'locales', 'META-INF', 'CSXS', '__pycache__', 'Cache', 'logs', 'CrashLogs',
]);

export function candidateExtensionRoots() {
  const roots = [];
  const appData = process.env.APPDATA;
  if (appData) roots.push({ kind: 'user', dir: path.join(appData, 'Adobe', 'CEP', 'extensions') });
  for (const dir of [
    'C:\\Program Files\\Common Files\\Adobe\\CEP\\extensions',
    'C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions',
  ]) {
    roots.push({ kind: 'system', dir });
  }
  return roots.filter((r) => existsDir(r.dir));
}

export function candidateAppRoots() {
  const out = [];
  for (const dir of ['D:\\Adobe', 'C:\\Program Files\\Adobe', 'C:\\Program Files (x86)\\Adobe']) {
    if (!existsDir(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const appDir = path.join(dir, e.name);
      for (const sub of ['Support Files', 'Required', 'Contents']) {
        const d = path.join(appDir, sub);
        if (existsDir(d)) out.push({ kind: 'app', app: e.name, dir: d });
      }
    }
  }
  return out;
}

function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Walk a directory tree looking for CSXS/manifest.xml files. */
function walkForManifests(dir, maxDepth, out) {
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: current, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    if (names.has('csxs')) {
      const manifest = path.join(current, 'CSXS', 'manifest.xml');
      if (fs.existsSync(manifest)) out.push(manifest);
    }
    if (depth >= maxDepth) continue;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      stack.push({ dir: path.join(current, e.name), depth: depth + 1 });
    }
  }
}

export function scanExtensions({ appRoots = true, maxAppDepth = 5 } = {}) {
  const manifestPaths = new Set();
  const roots = candidateExtensionRoots();
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const manifest = path.join(root.dir, e.name, 'CSXS', 'manifest.xml');
      if (fs.existsSync(manifest)) manifestPaths.add(manifest);
      // Bundles can carry nested extensions (e.g. CC Libraries).
      const nested = [];
      walkForManifests(path.join(root.dir, e.name), 3, nested);
      for (const m of nested) manifestPaths.add(m);
    }
  }
  if (appRoots) {
    for (const root of candidateAppRoots()) {
      const found = [];
      walkForManifests(root.dir, maxAppDepth, found);
      for (const m of found) manifestPaths.add(m);
    }
  }

  const bundles = [];
  const errors = [];
  const seen = new Set();
  for (const manifestPath of [...manifestPaths].sort()) {
    let real;
    try { real = fs.realpathSync(manifestPath).toLowerCase(); } catch { real = manifestPath.toLowerCase(); }
    if (seen.has(real)) continue;
    seen.add(real);
    const manifest = parseManifest(manifestPath);
    if (!manifest.ok) {
      errors.push(manifest);
      continue;
    }
    if (!manifest.extensions.length) {
      errors.push({ ...manifest, error: 'no extensions declared' });
      continue;
    }
    manifest.debug = readDebugFile(manifest.basePath);
    manifest.hasDebugFile = fs.existsSync(debugPathFor(manifest.basePath));
    manifest.debugPath = debugPathFor(manifest.basePath);
    bundles.push(manifest);
  }

  const byBasePath = new Map();
  const byExtId = new Map();
  for (const b of bundles) {
    byBasePath.set(b.basePath.toLowerCase(), b);
    for (const ext of b.extensions) {
      if (!byExtId.has(ext.id)) byExtId.set(ext.id, []);
      byExtId.get(ext.id).push({ bundle: b, ext });
    }
  }
  return { roots, bundles, errors, byBasePath, byExtId };
}

/** Extensions that declare at least one of the requested hosts. */
export function extensionsForHosts(scan, hosts) {
  const wanted = new Set(hosts);
  const out = [];
  for (const bundle of scan.bundles) {
    const hostNames = bundle.hosts.map((h) => h.name).filter((h) => wanted.has(h));
    if (!hostNames.length) continue;
    for (const ext of bundle.extensions) {
      out.push({ bundle, ext, hosts: hostNames });
    }
  }
  return out;
}

export function describeHosts(bundle) {
  return bundle.hosts.map((h) => h.name).join(',') || '-';
}

const APP_HOSTS = [
  [/after\s*effects/i, 'AEFT'],
  [/premiere/i, 'PPRO'],
  [/photoshop/i, 'PHXS'],
  [/illustrator/i, 'ILST'],
  [/indesign/i, 'IDSN'],
  [/animate/i, 'FLPR'],
  [/audition/i, 'AUDT'],
  [/dreamweaver/i, 'DRWV'],
  [/prelude/i, 'PRLD'],
  [/incopy/i, 'AICY'],
  [/lightroom/i, 'LTRM'],
];

/** Host ids for Adobe applications actually installed under the known app roots. */
export function detectInstalledHosts() {
  const hosts = new Set();
  for (const root of candidateAppRoots()) {
    for (const [re, host] of APP_HOSTS) {
      if (re.test(root.app)) hosts.add(host);
    }
  }
  if (!hosts.size) hosts.add('AEFT');
  return [...hosts];
}

/** Filter scan targets by host list and optional substring/regex patterns. */
export function filterTargets(targets, { hosts, only } = {}) {
  let out = targets;
  if (hosts?.length) {
    const wanted = new Set(hosts);
    out = out.filter((t) => t.hosts.some((h) => wanted.has(h)));
  }
  if (only?.length) {
    out = out.filter((t) => only.some((p) => matchesPattern(t, p)));
  }
  return out;
}

function matchesPattern(target, pattern) {
  const fields = [target.bundle.bundleId, target.bundle.basePath, target.ext.id, target.ext.menu];
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      const re = new RegExp(pattern.slice(1, -1), 'i');
      return fields.some((f) => re.test(f || ''));
    } catch {
      return false;
    }
  }
  const needle = pattern.toLowerCase();
  return fields.some((f) => String(f || '').toLowerCase().includes(needle));
}

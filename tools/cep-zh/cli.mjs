#!/usr/bin/env node
// cep-zh: Adobe CEP universal injection localizer (research prototype).
//
//   node cli.mjs scan     [--hosts AEFT,PPRO] [--only flow] [--json]
//   node cli.mjs enable   [--hosts ...] [--only ...] [--start 39300] [--dry-run] [--elevate]
//   node cli.mjs baseline  record current extension paths for new-plugin detection
//   node cli.mjs disable
//   node cli.mjs status
//   node cli.mjs agent    [--once] [--catalog] [--verbose]
//   node cli.mjs catalog  [--all | --port 39210]
//
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  scanExtensions, extensionsForHosts, detectInstalledHosts, filterTargets, describeHosts,
} from './lib/scan.mjs';
import {
  allocatePorts, applyAllocationsToState, groupByBundle, loadState, saveState,
  STATE_PATH, DEFAULT_START_PORT,
} from './lib/ports.mjs';
import {
  readDebugFile, mergeDebugEntries, writeDebugFile, debugPathFor, hashText, restoreDebugFile,
} from './lib/debugfile.mjs';
import { canWriteDir } from './lib/net.mjs';
import { discoverLivePanels, buildPortIndex, resolveLiveTarget } from './lib/live.mjs';
import { listTargets, connect, evaluate } from './lib/cdp.mjs';
import { EXTRACT_EXPR, mergeCatalog, saveCatalog, catalogPathFor } from './lib/catalog.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.join(TOOL_DIR, 'catalog');
const AGENT_PATH = path.join(TOOL_DIR, 'agent.mjs');

const splitList = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function parse(command, argv, options) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: false }).values;
}

function hostsFor(values, scan) {
  const explicit = splitList(values.hosts);
  if (explicit.length) return explicit;
  if (values['all-hosts']) {
    return [...new Set(scan.bundles.flatMap((b) => b.hosts.map((h) => h.name)))];
  }
  return detectInstalledHosts();
}

function cmdScan(argv) {
  const values = parse('scan', argv, {
    hosts: { type: 'string' }, 'all-hosts': { type: 'boolean', default: false },
    only: { type: 'string' }, json: { type: 'boolean', default: false },
    'no-app-roots': { type: 'boolean', default: false },
  });
  const scan = scanExtensions({ appRoots: !values['no-app-roots'] });
  const hosts = hostsFor(values, scan);
  const targets = filterTargets(extensionsForHosts(scan, hosts), { only: splitList(values.only) });

  if (values.json) {
    const byBundle = new Map();
    for (const t of targets) {
      if (!byBundle.has(t.bundle.basePath)) byBundle.set(t.bundle.basePath, { bundle: t.bundle, exts: [] });
      byBundle.get(t.bundle.basePath).exts.push(t);
    }
    const out = [...byBundle.values()].map(({ bundle, exts }) => ({
      bundleId: bundle.bundleId,
      bundleVersion: bundle.bundleVersion,
      basePath: bundle.basePath,
      hosts: bundle.hosts.map((h) => h.name),
      writable: canWriteDir(bundle.basePath),
      hasDebugFile: bundle.hasDebugFile,
      debug: bundle.debug,
      extensions: exts.map((t) => ({
        id: t.ext.id, hosts: t.hosts, mainPath: t.ext.mainPath, menu: t.ext.menu, type: t.ext.type,
      })),
    }));
    console.log(JSON.stringify({ hosts, bundles: out, errors: scan.errors }, null, 2));
    return 0;
  }

  console.log(`hosts: ${hosts.join(', ')}   bundles: ${new Set(targets.map((t) => t.bundle.basePath)).size}   extension targets: ${targets.length}`);
  console.log(['BUNDLE', 'VER', 'HOSTS', 'EXTS', 'DEBUG', 'W', 'PATH'].join('\t'));
  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.bundle.basePath)) continue;
    seen.add(t.bundle.basePath);
    const b = t.bundle;
    const dbg = Object.keys(b.debug).length ? Object.keys(b.debug).map((id) => Object.keys(b.debug[id]).map((h) => h + ':' + b.debug[id][h]).join('/')).join(',') : '-';
    console.log([b.bundleId, b.bundleVersion || '', describeHosts(b), b.extensions.length, dbg, canWriteDir(b.basePath) ? 'y' : 'N', b.basePath].join('\t'));
  }
  if (scan.errors.length) {
    console.log(`\nerrors: ${scan.errors.length} (first 5)`);
    for (const e of scan.errors.slice(0, 5)) console.log('  ', e.manifestPath, '-', e.error);
  }
  return 0;
}

function cmdBaseline() {
  const scan = scanExtensions();
  const root = process.env.APPDATA ? path.join(process.env.APPDATA, 'CEP-ZH') : TOOL_DIR;
  const file = path.join(root, 'debug-baseline.json');
  const paths = scan.bundles.map((b) => b.basePath.toLowerCase()).sort();
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), paths }, null, 2));
    console.log(`baseline: ${paths.length} extension paths -> ${file}`);
    return 0;
  } catch (err) {
    console.error('baseline failed:', err.message);
    return 1;
  }
}

async function cmdEnable(argv) {
  const values = parse('enable', argv, {
    hosts: { type: 'string' }, 'all-hosts': { type: 'boolean', default: false },
    only: { type: 'string' }, start: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    elevate: { type: 'boolean', default: false },
  });
  const scan = scanExtensions();
  const hosts = hostsFor(values, scan);
  const targets = filterTargets(extensionsForHosts(scan, hosts), { only: splitList(values.only) });
  if (!targets.length) {
    console.log('no matching CEP extension found for hosts', hosts.join(','));
    return 1;
  }

  const state = loadState();
  state.startPort = Number(values.start || state.startPort || DEFAULT_START_PORT);
  // Reserve every port already declared anywhere (including hosts not in this run),
  // so two Adobe apps never fight over the same loopback debug port.
  const reserved = new Set();
  for (const b of scan.bundles) {
    for (const hosts of Object.values(b.debug || {})) {
      for (const p of Object.values(hosts)) if (Number.isInteger(p)) reserved.add(p);
    }
  }
  for (const hosts of Object.values(state.ports || {})) {
    for (const p of Object.values(hosts)) if (Number.isInteger(p)) reserved.add(p);
  }
  const { allocations, warnings } = await allocatePorts(targets, {
    state, startPort: state.startPort, reserved: [...reserved],
  });
  for (const w of warnings) console.log('warning:', w);

  const groups = groupByBundle(allocations);
  const written = [];
  const unchanged = [];
  const skipped = [];
  const failed = [];

  for (const { bundle, additions } of groups) {
    const existing = readDebugFile(bundle.basePath);
    const merged = mergeDebugEntries(existing, additions);
    const debugPath = debugPathFor(bundle.basePath);
    if (!merged.changed && bundle.hasDebugFile) {
      unchanged.push({ bundle, additions });
      continue;
    }
    if (!canWriteDir(bundle.basePath)) {
      skipped.push({ bundle, additions, reason: 'read-only' });
      continue;
    }
    if (values['dry-run']) {
      written.push({ bundle, additions, dryRun: true });
      continue;
    }
    try {
      const prev = state.files?.[debugPath];
      const res = writeDebugFile(bundle.basePath, merged.entries, prev);
      state.files = state.files || {};
      state.files[debugPath] = {
        basePath: bundle.basePath,
        bundleId: bundle.bundleId,
        backup: res.backup,
        created: !bundle.hasDebugFile && !prev,
        hash: res.hash,
        extensionIds: [...new Set(additions.map((a) => a.id))],
        hosts: [...new Set(additions.flatMap((a) => Object.keys(a.hosts)))],
        updatedAt: new Date().toISOString(),
      };
      written.push({ bundle, additions, res });
    } catch (err) {
      failed.push({ bundle, error: err.message });
    }
  }

  if (!values['dry-run']) {
    applyAllocationsToState(state, allocations);
    saveState(state);
  }

  const portCount = new Set(allocations.map((a) => a.port)).size;
  console.log(`\n${values['dry-run'] ? '[dry-run] ' : ''}allocated ${portCount} ports for ${allocations.length} extension/host pairs`);
  if (written.length) {
    console.log(`\n${values['dry-run'] ? 'would write' : 'written'}: ${written.length} .debug files`);
    for (const w of written.slice(0, 12)) {
      const ports = w.additions.map((a) => Object.entries(a.hosts).map(([h, p]) => h + ':' + p).join('/')).join(' ');
      console.log(`  ${w.bundle.bundleId}  ${w.bundle.basePath}  ${ports}`);
    }
    if (written.length > 12) console.log(`  ... and ${written.length - 12} more`);
  }
  if (unchanged.length) console.log(`unchanged (developer .debug already covers these): ${unchanged.length}`);
  if (skipped.length) {
    console.log(`\nskipped (need administrator to write): ${skipped.length}`);
    for (const s of skipped.slice(0, 12)) console.log(`  ${s.bundle.bundleId}  ${s.bundle.basePath}`);
    if (skipped.length > 12) console.log(`  ... and ${skipped.length - 12} more`);
  }
  if (failed.length) {
    console.log(`\nfailed: ${failed.length}`);
    for (const f of failed) console.log(`  ${f.bundle.basePath}: ${f.error}`);
  }
  if (skipped.length) {
    if (values.elevate && process.platform === 'win32') {
      console.log('\nrequesting elevation...');
      const args = process.argv.slice(2).filter((a) => a !== '--elevate');
      const quoted = args.map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
      const cmd = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList @(${quoted}) -Verb RunAs`;
      spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { stdio: 'inherit' });
      return 0;
    }
    console.log('\nRun the same command from an elevated prompt (or add --elevate) to cover system-wide extensions.');
    console.log('User-level extensions in %APPDATA%\\Adobe\\CEP\\extensions were enabled without admin.');
    return 3;
  }
  return failed.length ? 4 : 0;
}

function cmdDisable() {
  const state = loadState();
  const files = state.files || {};
  let restored = 0, removed = 0, skipped = 0;
  for (const [file, meta] of Object.entries(files)) {
    if (!fs.existsSync(file)) { delete state.files[file]; continue; }
    try {
      const current = fs.readFileSync(file, 'utf8');
      if (meta.hash && hashText(current) !== meta.hash) {
        console.log(`skip (file changed by someone else): ${file}`);
        skipped++;
        continue;
      }
      const res = restoreDebugFile(meta.basePath, meta);
      if (res.restored === 'backup') restored++;
      else if (res.restored === 'deleted') removed++;
      delete state.files[file];
    } catch (err) {
      console.log(`skip (${err.message}): ${file}`);
      skipped++;
    }
  }
  saveState(state);
  console.log(`restored ${restored} backups, deleted ${removed} generated .debug files, skipped ${skipped}`);
  console.log('Restart Adobe applications so CEP stops opening debug ports.');
  return 0;
}

async function cmdStatus(argv) {
  const values = parse('status', argv, { json: { type: 'boolean', default: false } });
  const scan = scanExtensions();
  const state = loadState();
  const live = await discoverLivePanels();
  const portIndex = buildPortIndex(scan);
  const rows = live.map((l) => {
    const resolved = resolveLiveTarget(scan, portIndex, l);
    return {
      port: l.port,
      pid: l.pid,
      extId: resolved?.extId || '',
      bundleId: resolved?.bundle?.bundleId || '',
      title: l.page?.title || '',
      url: l.page?.url || '',
    };
  });
  if (values.json) {
    console.log(JSON.stringify({
      enabledFiles: Object.keys(state.files || {}).length,
      ports: Object.keys(state.ports || {}).length,
      bundles: scan.bundles.length,
      extensionIds: scan.byExtId.size,
      live: rows,
    }, null, 2));
    return 0;
  }
  console.log(`bundles: ${scan.bundles.length}   extension ids: ${scan.byExtId.size}   enabled .debug files: ${Object.keys(state.files || {}).length}`);
  console.log(`live panels (${rows.length}):`);
  console.log(['PORT', 'EXT', 'BUNDLE', 'TITLE'].join('\t'));
  for (const r of rows) console.log([r.port, r.extId, r.bundleId, r.title].join('\t'));
  if (!rows.length) console.log('  (none - start an Adobe app and open a CEP panel)');
  return 0;
}

async function cmdCatalog(argv) {
  const values = parse('catalog', argv, { port: { type: 'string' }, all: { type: 'boolean', default: false }, verbose: { type: 'boolean', default: false } });
  const scan = scanExtensions();
  const portIndex = buildPortIndex(scan);
  let items;
  if (values.port) {
    items = [{ port: Number(values.port), page: null }];
  } else {
    items = await discoverLivePanels();
  }
  if (!items.length) {
    console.log('no live CEP panel found');
    return 1;
  }
  let saved = 0;
  for (const item of items) {
    try {
      const targets = item.page ? [item.page] : await listTargets(item.port);
      const page = targets.find((t) => t.type === 'page');
      if (!page) continue;
      const resolved = resolveLiveTarget(scan, portIndex, { port: item.port, page });
      const client = await connect(page.webSocketDebuggerUrl);
      // Temporarily restore original English text before extracting the catalog.
      await evaluate(client, 'window.__CEP_ZH__ && window.__CEP_ZH__.off ? (window.__CEP_ZH__.off(), true) : false').catch(() => {});
      const raw = await evaluate(client, EXTRACT_EXPR);
      await evaluate(client, 'window.__CEP_ZH__ && window.__CEP_ZH__.enable ? (window.__CEP_ZH__.enable(), true) : false').catch(() => {});
      client.close();
      if (!raw) continue;
      const extracted = JSON.parse(raw);
      const key = resolved?.bundle?.bundleId || resolved?.extId || 'port_' + item.port;
      const file = catalogPathFor(CATALOG_DIR, key);
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const merged = mergeCatalog(existing, extracted, { bundleId: resolved?.bundle?.bundleId, extId: resolved?.extId });
      const out = saveCatalog(CATALOG_DIR, key, merged);
      saved++;
      console.log(`:${item.port}  ${key}  ${Object.keys(merged.strings).length} strings / ${Object.keys(merged.attrs).length} attrs  -> ${path.relative(TOOL_DIR, out)}`);
    } catch (err) {
      console.log(`:${item.port}  failed: ${err.message}`);
    }
  }
  return saved ? 0 : 1;
}

function spawnAgent(argv) {
  const r = spawnSync(process.execPath, [AGENT_PATH, ...argv], { stdio: 'inherit' });
  return r.status ?? 1;
}

function help() {
  console.log(`cep-zh - Adobe CEP universal injection localizer

Usage:
  node cli.mjs scan     [--hosts AEFT,PPRO] [--only flow] [--json]
  node cli.mjs enable   [--hosts ...] [--only ...] [--start 39300] [--dry-run] [--elevate]
  node cli.mjs disable
  node cli.mjs status   [--json]
  node cli.mjs agent    [--once] [--catalog] [--verbose] [--interval 2000]
  node cli.mjs catalog  [--all | --port 39210]

How it works:
  1. enable writes a per-extension ".debug" file (official CEP remote-debugging
     config) into each extension folder, allocating one localhost port per
     extension / host pair.
  2. Restart the Adobe application.
  3. agent watches CEPHtmlEngine.exe's localhost DevTools ports, attaches over
     CDP and injects runtime/runtime.js plus a dictionary into every panel.
  4. Put translations in dict/global.json or dict/extensions/<bundleId>.json
     as {"strings": {"English": "涓枃"}}. The agent hot-reloads the dictionary.

Admin: extension folders under "C:\\Program Files*" are read-only for normal
users. Run enable from an elevated prompt (or add --elevate) to cover them;
%APPDATA%\\Adobe\\CEP\\extensions is writable without admin.

State: ${STATE_PATH}
`);
}

const command = process.argv[2] || 'help';
const rest = process.argv.slice(3);

let code = 0;
switch (command) {
  case 'scan': code = cmdScan(rest); break;
  case 'enable': code = await cmdEnable(rest); break;
  case 'baseline': code = cmdBaseline(); break;
  case 'disable': code = cmdDisable(rest); break;
  case 'status': code = await cmdStatus(rest); break;
  case 'catalog': code = await cmdCatalog(rest); break;
  case 'agent': code = spawnAgent(rest); break;
  case 'inject': code = spawnAgent(['--once', ...rest]); break;
  case 'help': case '--help': case '-h': help(); break;
  default:
    console.error('unknown command:', command);
    help();
    code = 2;
}
process.exit(code);


// cep-zh agent: discover CEP panels, inject runtime, collect words, honor control.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';

import { scanExtensions, detectInstalledHosts } from './lib/scan.mjs';
import { buildPortIndex, discoverLivePanels, resolveLiveTarget } from './lib/live.mjs';
import { loadDictionaries, buildConfigFor, dictionaryRoots } from './lib/dict.mjs';
import { attach, reinject, evaluateOn } from './lib/inject.mjs';
import { listTargets, connect, evaluate } from './lib/cdp.mjs';
import { EXTRACT_EXPR, mergeCatalog, saveCatalog, catalogPathFor } from './lib/catalog.mjs';
import { isTranslatable, loadTranslationConfig, translateStrings } from './lib/translate-api.mjs';
import { loadState } from './lib/ports.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.join(TOOL_DIR, 'catalog');
const USER_ROOT = process.env.APPDATA ? path.join(process.env.APPDATA, 'CEP-ZH') : path.join(TOOL_DIR, 'userdata');
const USER_DICT_DIR = path.join(USER_ROOT, 'dict');
const USER_EXT_DIR = path.join(USER_DICT_DIR, 'extensions');
const CONTROL_PATH = path.join(USER_ROOT, 'control.json');
const STATE_PATH = path.join(USER_ROOT, 'state.json');
const BASELINE_PATH = path.join(USER_ROOT, 'debug-baseline.json');
const CLI_PATH = path.join(TOOL_DIR, 'cli.mjs');

const { values: args } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    catalog: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    interval: { type: 'string', default: '1000' },
    'no-watch': { type: 'boolean', default: false },
    'no-rescan': { type: 'boolean', default: false },
    'host-pid': { type: 'string' },
    'host-id': { type: 'string' },
  },
});

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const vlog = (...a) => { if (args.verbose) log(...a); };

let scan = scanExtensions();
let installedHosts = new Set(detectInstalledHosts());
let debugBaseline = loadDebugBaseline();
if (!debugBaseline) debugBaseline = createDebugBaseline();
let dicts = loadDictionaries();
let portIndex = buildPortIndex(scan);
let control = readControl();
const sessions = new Map(); // port -> session
const autoCollected = new Set(); // bundleId|url
let lastCollectToken = '';
let lastCollect = null;
let lastLive = [];
let controlBusy = false;
let controlTimer = null;
let translationRunning = false;
let lastTranslationToken = '';
let lastRepairToken = '';
let lastRepair = null;
let lastAutoDebug = null;
let autoDebugRepairing = false;
const autoDebugAttempted = new Set();
let translation = {
  running: false, token: '', scope: '', bundleId: '',
  total: 0, done: 0, translated: 0, skipped: 0,
  error: '', startedAt: '', finishedAt: '',
};

function readControl() {
  try {
    const j = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8').replace(/^\uFEFF/, ''));
    const t = j.translationTask;
    return {
      enabled: j.enabled !== false,
      disabledPlugins: Array.isArray(j.disabledPlugins) ? j.disabledPlugins.map(String) : [],
      collectToken: j.collectToken ? String(j.collectToken) : '',
      repairDebugToken: j.repairDebugToken ? String(j.repairDebugToken) : '',
      translationTask: t && t.token ? {
        token: String(t.token),
        scope: t.scope === 'all' ? 'all' : 'plugin',
        bundleId: String(t.bundleId || ''),
      } : null,
    };
  } catch {
    return { enabled: true, disabledPlugins: [], collectToken: '', repairDebugToken: '', translationTask: null };
  }
}

function ensureUserDirs() {
  try { fs.mkdirSync(USER_EXT_DIR, { recursive: true }); } catch {}
}

function sanitizeKey(s) {
  return String(s || 'unknown').replace(/[^\w.-]+/g, '_');
}

function pluginKey(bundle, extId) {
  return sanitizeKey(bundle?.bundleId || extId || 'unknown');
}

function pluginIds(bundle, extId) {
  return [bundle?.bundleId, extId].filter(Boolean).map(String);
}

function isPluginDisabled(bundle, extId) {
  const ids = pluginIds(bundle, extId);
  return ids.some((id) => control.disabledPlugins.includes(id));
}

function configFor(port, bundle, extId) {
  const cfg = buildConfigFor(dicts, { bundle, extId, port });
  cfg.port = port;
  return cfg;
}

function resolve(port, page) {
  return resolveLiveTarget(scan, portIndex, { port, page: page || {} });
}

function loadDebugBaseline() {
  try {
    const doc = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (Array.isArray(doc.paths)) return new Set(doc.paths.map((p) => String(p).toLowerCase()));
  } catch {}
  return null;
}

function createDebugBaseline() {
  const paths = scan.bundles.map((b) => b.basePath.toLowerCase()).sort();
  try {
    fs.mkdirSync(USER_ROOT, { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), paths }, null, 2));
  } catch (err) {
    vlog('debug baseline write failed', err.message);
  }
  return new Set(paths);
}

function pendingDebug() {
  const out = [];
  for (const bundle of scan.bundles) {
    if (!bundle || bundle.hasDebugFile) continue;
    const bundleId = String(bundle.bundleId || '');
    if (!bundleId || bundleId.startsWith('cep.zh.')) continue;
    if (debugBaseline && debugBaseline.has(String(bundle.basePath).toLowerCase())) continue;
    const hosts = (bundle.hosts || []).map((h) => h.name).filter((h) => installedHosts.has(h));
    if (!hosts.length) continue;
    let writable = false;
    try { fs.accessSync(bundle.basePath, fs.constants.W_OK); writable = true; } catch {}
    out.push({ bundleId, path: bundle.basePath, hosts, writable });
  }
  return out;
}

function writeState(panels) {
  try {
    fs.mkdirSync(USER_ROOT, { recursive: true });
    const state = {
      agentPid: process.pid,
      updatedAt: new Date().toISOString(),
      enabled: control.enabled,
      disabledPlugins: control.disabledPlugins,
      lastCollect,
      translation,
      pendingDebug: pendingDebug(),
      lastRepair,
      lastAutoDebug,
      panels: panels || [],
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    vlog('state write failed', err.message);
  }
}

async function offSession(session) {
  try {
    if (session.identifier) {
      await session.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.identifier }).catch(() => {});
      session.identifier = null;
    }
    await evaluateOn(session, 'window.__CEP_ZH__ && window.__CEP_ZH__.off ? (window.__CEP_ZH__.off(), true) : true');
  } catch {}
}

async function applyControl() {
  const jobs = [];
  for (const session of sessions.values()) {
    jobs.push((async () => {
      const desiredDisabled = !control.enabled || isPluginDisabled(session.bundle, session.extId);
      if (desiredDisabled && !session.translationDisabled) {
        await offSession(session);
        session.translationDisabled = true;
        log(`[off] :${session.port} ${session.bundle?.bundleId || session.extId || ''}`);
      } else if (!desiredDisabled && session.translationDisabled) {
        try {
          await reinject(session, configFor(session.port, session.bundle, session.extId));
          session.translationDisabled = false;
          log(`[on]  :${session.port} ${session.bundle?.bundleId || session.extId || ''}`);
        } catch (err) {
          vlog('re-enable failed', session.port, err.message);
        }
      }
    })());
  }
  await Promise.all(jobs);
  writeState(panelState(lastLive));
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function translationKeys(task) {
  if (task.scope !== 'all') return task.bundleId ? [sanitizeKey(task.bundleId)] : [];
  ensureUserDirs();
  try {
    return fs.readdirSync(USER_EXT_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => f.replace(/\.json$/i, ''))
      .filter((k) => !k.startsWith('cep.zh.'));
  } catch {
    return [];
  }
}

function translationCandidates(keys) {
  const perKey = [];
  const all = new Set();
  let skipped = 0;
  for (const key of keys) {
    const userFile = path.join(USER_EXT_DIR, key + '.json');
    const user = readJsonSafe(userFile, { name: key, strings: {}, patterns: [] });
    if (!user.strings) user.strings = {};
    if (!Array.isArray(user.patterns)) user.patterns = [];
    const record = dicts.byKey.get(key) || dicts.byKey.get(key.toLowerCase());
    const existing = record?.strings || {};
    const common = dicts.global.strings || {};
    const todo = [];
    const candidates = new Set([...Object.keys(user.strings), ...Object.keys(existing)]);
    for (const s of candidates) {
      if (user.strings[s] || existing[s] || common[s]) { skipped++; continue; }
      if (!isTranslatable(s)) { skipped++; continue; }
      todo.push(s);
      all.add(s);
    }
    if (todo.length) perKey.push({ key, user, todo });
  }
  return { perKey, strings: [...all], skipped };
}

async function runTranslationTask(task) {
  if (translationRunning) return;
  translationRunning = true;
  translation = {
    running: true, token: task.token, scope: task.scope, bundleId: task.bundleId,
    total: 0, done: 0, translated: 0, skipped: 0,
    error: '', startedAt: new Date().toISOString(), finishedAt: '',
  };
  writeState(panelState(lastLive));
  log(`[translate] start scope=${task.scope} bundle=${task.bundleId || 'all'}`);
  try {
    const cfg = loadTranslationConfig();
    if (!cfg.provider || cfg.provider === 'none') throw new Error('翻译 API 未配置，请先在设置里填写 provider / Key');
    const keys = translationKeys(task);
    if (!keys.length) throw new Error('没有可翻译的插件字典');
    const { perKey, strings, skipped } = translationCandidates(keys);
    translation.total = strings.length;
    translation.skipped = skipped;
    writeState(panelState(lastLive));
    if (!strings.length) {
      log('[translate] nothing to translate');
      return;
    }
    const map = await translateStrings(cfg, strings, {
      onProgress(done, total) {
        translation.done = done;
        translation.total = total;
        writeState(panelState(lastLive));
      },
    });
    let translated = 0;
    for (const item of perKey) {
      let changed = false;
      for (const s of item.todo) {
        if (map[s]) { item.user.strings[s] = map[s]; translated++; changed = true; }
      }
      if (changed) {
        item.user.name = item.user.name || item.key;
        fs.writeFileSync(path.join(USER_EXT_DIR, item.key + '.json'), JSON.stringify(item.user, null, 2), 'utf8');
      }
    }
    translation.translated = translated;
    log(`[translate] done translated=${translated} skipped=${skipped}`);
  } catch (err) {
    translation.error = err.message;
    log('[translate] error:', err.message);
  } finally {
    translation.running = false;
    translation.finishedAt = new Date().toISOString();
    translationRunning = false;
    writeState(panelState(lastLive));
    dicts = loadDictionaries();
  }
}

async function syncControl() {
  if (controlBusy) return;
  controlBusy = true;
  try {
    const next = readControl();
    const changed = next.enabled !== control.enabled ||
      JSON.stringify(next.disabledPlugins) !== JSON.stringify(control.disabledPlugins);
    control = next;
    if (changed) await applyControl();
    if (control.translationTask && control.translationTask.token !== lastTranslationToken) {
      lastTranslationToken = control.translationTask.token;
      if (!translationRunning) {
        runTranslationTask(control.translationTask).catch((err) => log('[translate] failed', err.message));
      }
    }
    if (control.repairDebugToken && control.repairDebugToken !== lastRepairToken) {
      lastRepairToken = control.repairDebugToken;
      repairPendingDebug(control.repairDebugToken);
    }
  } finally {
    controlBusy = false;
  }
}

function repairPendingDebug(token) {  const pending = pendingDebug();
  const total = pending.length;
  if (!total) {
    lastRepair = {
      token, at: new Date().toISOString(), status: 'done', total: 0, remaining: 0,
      message: '没有待补写的插件',
    };
    writeState(panelState(lastLive));
    return;
  }

  const ids = [...new Set(pending.map((p) => p.bundleId))];
  const hosts = [...new Set(pending.flatMap((p) => p.hosts))];
  const needElevate = pending.some((p) => !p.writable);
  const args = [CLI_PATH, 'enable', '--hosts', hosts.join(','), '--only', ids.join(',')];
  if (needElevate) args.push('--elevate');

  lastRepair = {
    token, at: new Date().toISOString(), status: 'running', total,
    remaining: total, elevated: needElevate,
    message: needElevate ? '写入用户目录，并请求管理员权限处理系统目录' : '正在写入 .debug',
  };
  log(`[debug] repair ${ids.length} bundle(s), elevated=${needElevate}`);
  writeState(panelState(lastLive));

  let child;
  try {
    child = spawn(process.execPath, args, { cwd: TOOL_DIR, windowsHide: true, stdio: 'ignore' });
  } catch (err) {
    lastRepair = {
      token, at: new Date().toISOString(), status: 'error', total, remaining: total,
      message: err.message,
    };
    writeState(panelState(lastLive));
    return;
  }

  child.on('error', (err) => {
    lastRepair = {
      token, at: new Date().toISOString(), status: 'error', total, remaining: total,
      message: err.message,
    };
    writeState(panelState(lastLive));
  });

  child.on('exit', (code) => {
    try {
      scan = scanExtensions();
      installedHosts = new Set(detectInstalledHosts());
      portIndex = buildPortIndex(scan);
    } catch (err) {
      vlog('post-repair rescan failed', err.message);
    }
    const remaining = pendingDebug().length;
    const status = remaining === 0 ? 'done' : (needElevate ? 'elevated' : 'error');
    lastRepair = {
      token, at: new Date().toISOString(), status, total, remaining,
      elevated: needElevate,
      message: status === 'done'
        ? '已写入 .debug，请重启 Adobe 应用'
        : (status === 'elevated'
          ? '已请求管理员写入系统目录；完成后请重启 Adobe 应用'
          : `仍有 ${remaining} 个插件未写入，请查看日志`),
    };
    writeState(panelState(lastLive));
    log(`[debug] repair exit=${code} remaining=${remaining} status=${status}`);
  });
}

function autoRepairWritable() {
  if (autoDebugRepairing) return;
  const pending = pendingDebug().filter((p) => p.writable && !autoDebugAttempted.has(p.path));
  if (!pending.length) return;
  pending.forEach((p) => autoDebugAttempted.add(p.path));
  autoDebugRepairing = true;
  const ids = [...new Set(pending.map((p) => p.bundleId))];
  const hosts = [...new Set(pending.flatMap((p) => p.hosts))];
  log(`[debug] auto-write ${ids.length} writable bundle(s)`);
  let child;
  try {
    child = spawn(process.execPath,
      [CLI_PATH, 'enable', '--hosts', hosts.join(','), '--only', ids.join(',')],
      { cwd: TOOL_DIR, windowsHide: true, stdio: 'ignore' });
  } catch (err) {
    autoDebugRepairing = false;
    vlog('auto debug spawn failed', err.message);
    return;
  }
  child.on('error', (err) => {
    autoDebugRepairing = false;
    vlog('auto debug failed', err.message);
  });
  child.on('exit', () => {
    autoDebugRepairing = false;
    try {
      scan = scanExtensions();
      installedHosts = new Set(detectInstalledHosts());
      portIndex = buildPortIndex(scan);
    } catch (err) {
      vlog('auto-debug rescan failed', err.message);
    }
    const remaining = pendingDebug().length;
    lastAutoDebug = {
      at: new Date().toISOString(),
      count: ids.length,
      status: remaining === 0 ? 'done' : 'pending',
      remaining,
      message: remaining === 0
        ? '新插件已自动写入 .debug，请重启 Adobe 应用'
        : '部分新插件的 .debug 写入失败，请在管理面板中修复',
    };
    writeState(panelState(lastLive));
  });
}

function watchControl() {  try {
    fs.mkdirSync(USER_ROOT, { recursive: true });
    fs.watch(USER_ROOT, (_event, filename) => {
      if (filename && String(filename).toLowerCase() !== 'control.json') return;
      clearTimeout(controlTimer);
      controlTimer = setTimeout(() => {
        syncControl().catch((err) => vlog('control apply failed', err.message));
      }, 25);
    });
    log('[control] watching', CONTROL_PATH);
  } catch (err) {
    log('[control] watch unavailable:', err.message);
  }
}

function existingTranslationSet(key) {
  const set = new Set();
  const rec = dicts.byKey.get(key) || dicts.byKey.get(key.toLowerCase());
  if (rec) {
    for (const [k, v] of Object.entries(rec.strings || {})) if (v) set.add(k);
  }
  for (const [k, v] of Object.entries(dicts.global.strings || {})) if (v) set.add(k);
  return set;
}

function mergeWordsIntoDict(key, extracted) {
  ensureUserDirs();
  const file = path.join(USER_EXT_DIR, key + '.json');
  let dict = { name: key, strings: {}, patterns: [] };
  try { dict = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!dict.strings) dict.strings = {};
  if (!Array.isArray(dict.patterns)) dict.patterns = [];
  const covered = existingTranslationSet(key);
  let added = 0;
  const words = new Set([
    ...(extracted.text || []).map((x) => x[0]),
    ...(extracted.attrs || []).map((x) => x[0]),
  ]);
  for (const word of words) {
    if (!isTranslatable(word)) continue;
    if (!word || covered.has(word)) continue;
    if (Object.prototype.hasOwnProperty.call(dict.strings, word)) continue;
    dict.strings[word] = '';
    added++;
  }
  if (added) {
    fs.writeFileSync(file, JSON.stringify(dict, null, 2), 'utf8');
    dicts = loadDictionaries();
    log(`[collect] ${key} +${added} words -> ${path.relative(USER_ROOT, file)}`);
  }
  return added;
}

async function extractOriginals(client, wasAttached) {
  let wasOn = false;
  try {
    wasOn = await evaluate(client, '!!(window.__CEP_ZH__ && window.__CEP_ZH__.stats && window.__CEP_ZH__.stats().enabled)');
  } catch {}
  if (wasOn) {
    try { await evaluate(client, 'window.__CEP_ZH__.off(); true'); } catch {}
  }
  let raw = null;
  try { raw = await evaluate(client, EXTRACT_EXPR); } catch {}
  if (wasOn && control.enabled) {
    try { await evaluate(client, 'window.__CEP_ZH__.enable(); true'); } catch {}
  }
  return raw;
}

async function collectSession(session) {
  if (!session) return 0;
  const key = pluginKey(session.bundle, session.extId);
  const raw = await extractOriginals(session.client);
  if (!raw) return 0;
  return mergeWordsIntoDict(key, JSON.parse(raw));
}

async function collectPort(port, page) {
  let client = null;
  try {
    const pageTarget = page || (await listTargets(port)).find((t) => t.type === 'page');
    if (!pageTarget) return 0;
    client = await connect(pageTarget.webSocketDebuggerUrl);
    const raw = await extractOriginals(client);
    if (!raw) return 0;
    const resolved = resolve(port, pageTarget);
    const key = pluginKey(resolved?.bundle, resolved?.extId);
    if (key.startsWith('cep.zh.')) return 0;
    return mergeWordsIntoDict(key, JSON.parse(raw));
  } catch (err) {
    vlog('collect failed', port, err.message);
    return 0;
  } finally {
    if (client) try { client.close(); } catch {}
  }
}

async function collectAll(live) {
  let added = 0;
  for (const item of live) {
    const session = sessions.get(item.port);
    if (session) added += await collectSession(session);
    else added += await collectPort(item.port, item.page);
  }
  lastCollect = { token: lastCollectToken, at: new Date().toISOString(), added };
  log(`[collect] all panels: +${added} words`);
  return added;
}

async function injectPanel(live) {
  const resolved = resolve(live.port, live.page);
  const bundle = resolved?.bundle || null;
  const extId = resolved?.extId || '';
  const bundleId = bundle?.bundleId || extId || '';
  // Never inject into our own manager/agent panels: the editor must keep its
  // original English dictionary keys and its own Chinese UI.
  if (bundleId.startsWith('cep.zh.')) return null;
  if (!control.enabled || isPluginDisabled(bundle, extId)) {
    vlog('[skip]', live.port, bundleId, 'disabled');
    return null;
  }
  const cfg = configFor(live.port, bundle, extId);
  try {
    const session = await attach(live.port, cfg);
    session.bundle = bundle;
    session.extId = extId;
    session.title = live.page?.title || '';
    session.url = live.page?.url || '';
    session.translationDisabled = false;
    sessions.set(live.port, session);

    session.client.on((msg) => {
      if (msg.method === 'Page.frameNavigated') {
        setTimeout(async () => {
          if (session.translationDisabled) return;
          try { await evaluateOn(session, session.source); } catch {}
          // Panels often rebuild their UI on reload; capture any newly appeared words.
          setTimeout(() => {
            if (session.translationDisabled) return;
            collectSession(session).catch((err) => vlog('reload collect failed', err.message));
          }, 900);
        }, 300);
      }
    });

    const stats = session.stats || {};
    log(`[inject] :${live.port}  ${bundleId}  dict=${cfg.dictionaryFiles.map((f) => path.basename(f)).join('+') || 'global'}  changed=${stats.changed ?? '?'}`);

    const key = `${bundleId}|${session.url}`;
    if (bundleId && !bundleId.startsWith('cep.zh.') && !autoCollected.has(key)) {
      autoCollected.add(key);
      try { await collectSession(session); } catch (err) { vlog('auto collect failed', err.message); }
    }
    return session;
  } catch (err) {
    log(`[inject] :${live.port} failed: ${err.message}`);
    return null;
  }
}

function panelState(live) {
  return live.map((item) => {
    const resolved = resolve(item.port, item.page);
    const session = sessions.get(item.port);
    const bundle = resolved?.bundle || session?.bundle || null;
    const extId = resolved?.extId || session?.extId || '';
    const bundleId = bundle?.bundleId || '';
    const disabled = !control.enabled || isPluginDisabled(bundle, extId);
    return {
      port: item.port,
      pid: item.pid,
      title: item.page?.title || '',
      url: item.page?.url || '',
      bundleId,
      extId,
      disabled,
      injected: !!session && !session.translationDisabled,
      stats: session?.stats || null,
    };
  }).filter((p) => !String(p.bundleId).startsWith('cep.zh.'));
}

async function tick() {
  await syncControl();

  const live = await discoverLivePanels();
  lastLive = live;
  const livePorts = new Set(live.map((l) => l.port));

  for (const [port, session] of sessions) {
    if (!livePorts.has(port) || session.client.ws.readyState !== 1) {
      try { session.client.close(); } catch {}
      sessions.delete(port);
      vlog(`[drop] :${port}`);
    }
  }

  for (const item of live) {
    if (sessions.has(item.port)) continue;
    await injectPanel(item);
  }

  if (control.collectToken && control.collectToken !== lastCollectToken) {
    lastCollectToken = control.collectToken;
    await collectAll(live);
  }

  autoRepairWritable();
  writeState(panelState(live));
  return live.length;
}

async function reloadDictionaries() {
  dicts = loadDictionaries();
  log(`[dict] reloaded (${dicts.byKey.size} keys)`);
  for (const session of sessions.values()) {
    if (session.translationDisabled) continue;
    try {
      await reinject(session, configFor(session.port, session.bundle, session.extId));
      log(`[inject] :${session.port} re-injected after dictionary change (changed=${session.stats?.changed ?? '?'})`);
    } catch (err) {
      vlog('reinject failed', session.port, err.message);
    }
  }
}

function watchDictionaries() {
  if (args['no-watch']) return;
  let timer = null;
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => reloadDictionaries().catch((e) => log('[dict] reload error', e.message)), 400);
  };
  for (const dir of dictionaryRoots()) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.watch(dir, { recursive: true }, onChange);
      log('[dict] watching', dir);
    } catch (err) {
      log('[dict] watch unavailable:', dir, err.message);
    }
  }
}

async function main() {
  ensureUserDirs();
  log(`cep-zh agent | ${scan.bundles.length} bundles | ${scan.byExtId.size} extension ids | control=${CONTROL_PATH}`);
  if (args['host-pid']) log(`host-pid=${args['host-pid']}${args['host-id'] ? ' host-id=' + args['host-id'] : ''}`);
  writeState([]);

  if (args.once) {
    const count = await tick();
    log(`[once] live panels: ${count}, injected: ${sessions.size}`);
    for (const s of sessions.values()) try { s.client.close(); } catch {}
    return;
  }

  watchDictionaries();
  watchControl();
  if (!args['no-rescan']) {
    setInterval(() => {
      try {
        scan = scanExtensions();
        installedHosts = new Set(detectInstalledHosts());
        portIndex = buildPortIndex(scan);
      } catch (err) {
        vlog('rescan failed', err.message);
      }
    }, 15000);
  }
  const interval = Math.max(300, Number(args.interval) || 1000);
  log(`polling every ${interval} ms; Ctrl+C to stop`);
  for (;;) {
    try { await tick(); } catch (err) { log('tick error:', err.message); }
    await new Promise((r) => setTimeout(r, interval));
  }
}

process.on('SIGINT', () => {
  for (const s of sessions.values()) try { s.client.close(); } catch {}
  log('stopped');
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

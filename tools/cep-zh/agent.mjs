// cep-zh agent: discover CEP panels, inject runtime, collect words, honor control.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
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
import { loadDebugBaseline, writeDebugBaseline } from './lib/baseline.mjs';
import { canWriteDir } from './lib/net.mjs';

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
let debugBaseline = loadDebugBaseline(BASELINE_PATH);
if (!debugBaseline) debugBaseline = createDebugBaseline();
let dicts = loadDictionaries();
let portIndex = buildPortIndex(scan);
let control = readControl();
clearStaleRepairToken();
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
let updateState = { token: '', status: 'idle', message: '', version: '' };
let lastUpdateToken = '';
let updateRunning = false;
const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAlUHUPkm01Y0ZgG8phLPU
vKWLlaZr5xJ2cTplJ3yj5RWklYytHVk9nK0tSJItahfh8PFGmdQqZA+9CHep6FNd
BGtKYi2b/6u4M7NezQAjSQ2tE0NaFYA+spSUBsxZ3QnA9wrXY2ggvtPhRC0Je9+u
W1aonu256mYdZr8o84pPGKzfdn7jpNQnV8HyU9d8w6sejguJHTEO8ST6kzJtagOw
JFxo6fK1Ce73pEEarzaX3VxK+zWE8H6kiemt6FauchvoHdRRKDxFf1GcjqMppKc5
ZMH2+OFNC9qVkA/+4W6e3BWmys+FQ65CbZc1s83QynNU17K8Q8Zh0S1Fd1yFU8WE
Zy4nXUUesk1AFAQYSOBV9cOGO46JYwcYpwBOMZAMkSwU/lA9XeZ4ACwPPgxkONkR
AX+q5h1bF6gljawd6PGMOjzZpq0dk6vfzTFLhz3Y3PrCE4c7+emgZIiVZN4oyPjx
dxutBFYnIdTaLAEbAspyQ+rfyuPScem/vyTZD1A64IFxAgMBAAE=
-----END PUBLIC KEY-----`;

function readControl() {
  try {
    const j = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8').replace(/^\uFEFF/, ''));
    const t = j.translationTask;
    const u = j.updateTask;
    return {
      enabled: j.enabled !== false,
      disabledPlugins: Array.isArray(j.disabledPlugins) ? j.disabledPlugins.map(String) : [],
      collectToken: j.collectToken ? String(j.collectToken) : '',
      repairDebugToken: j.repairDebugToken ? String(j.repairDebugToken) : '',
      repairDebugRequestedAt: Number(j.repairDebugRequestedAt) || 0,
      translationTask: t && t.token ? {
        token: String(t.token),
        scope: t.scope === 'all' ? 'all' : 'plugin',
        bundleId: String(t.bundleId || ''),
      } : null,
      updateTask: u && u.token ? {
        token: String(u.token),
        requestedAt: Number(u.requestedAt) || 0,
      } : null,
    };
  } catch {
    return { enabled: true, disabledPlugins: [], collectToken: '', repairDebugToken: '', repairDebugRequestedAt: 0, translationTask: null, updateTask: null };
  }
}

function clearStaleRepairToken() {
  if (!control.repairDebugToken) return;
  const at = Number(control.repairDebugRequestedAt) || 0;
  if (at && Date.now() - at < 120000) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8').replace(/^\uFEFF/, ''));
    delete raw.repairDebugToken;
    delete raw.repairDebugRequestedAt;
    fs.writeFileSync(CONTROL_PATH, JSON.stringify(raw, null, 2));
    control.repairDebugToken = '';
    control.repairDebugRequestedAt = 0;
    log('[control] cleared stale repair token');
  } catch (err) {
    vlog('stale repair token cleanup failed', err.message);
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

function createDebugBaseline() {
  try {
    return writeDebugBaseline(BASELINE_PATH, scan);
  } catch (err) {
    vlog('debug baseline write failed', err.message);
    return debugBaseline || new Map();
  }
}

function refreshDebugBaseline() {
  try {
    debugBaseline = writeDebugBaseline(BASELINE_PATH, scan);
  } catch (err) {
    vlog('debug baseline refresh failed', err.message);
  }
}

function pendingDebug() {
  const out = [];
  for (const bundle of scan.bundles) {
    if (!bundle || bundle.hasDebugFile) continue;
    const bundleId = String(bundle.bundleId || '');
    if (!bundleId || bundleId.startsWith('cep.zh.')) continue;
    // A missing .debug is actionable even when it existed at baseline time.
    // Baseline tracks the initial state, but a later manual deletion (or a
    // plugin update) must still surface in the manager.
    const hosts = (bundle.hosts || []).map((h) => h.name).filter((h) => installedHosts.has(h));
    if (!hosts.length) continue;
    let writable = false;
    try { writable = canWriteDir(bundle.basePath); } catch {}
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
      update: updateState,
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

function httpsBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'CEP-ZH-Agent' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next = res.headers.location;
        if (!/^https?:\/\//i.test(next)) next = new URL(next, url).toString();
        resolve(httpsBuffer(next, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
  });
}

async function fetchSignedManifest() {
  const urls = [
    'https://github.com/Three-LEI/CEP-ZH/releases/latest/download/CEP-ZH-manifest.json',
    'https://ghfast.top/https://github.com/Three-LEI/CEP-ZH/releases/latest/download/CEP-ZH-manifest.json',
    'https://gh-proxy.com/https://github.com/Three-LEI/CEP-ZH/releases/latest/download/CEP-ZH-manifest.json'
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const manifest = await httpsBuffer(url);
      const signature = await httpsBuffer(url.replace(/\.json$/i, '.sig'));
      if (!crypto.verify('sha256', manifest, UPDATE_PUBLIC_KEY, signature)) {
        throw new Error('更新清单签名校验失败');
      }
      const data = JSON.parse(manifest.toString('utf8').replace(/^\uFEFF/, ''));
      if (!data.version || !/^[0-9a-f]{64}$/i.test(String(data.installerSha256 || ''))) {
        throw new Error('更新清单缺少安装器哈希');
      }
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('无法获取更新清单');
}

async function downloadInstaller(manifest) {
  const version = String(manifest.version).replace(/^v/i, '');
  const prefixes = [
    'https://ghfast.top/https://github.com/Three-LEI/CEP-ZH/releases/download/',
    'https://gh-proxy.com/https://github.com/Three-LEI/CEP-ZH/releases/download/',
    'https://ghproxy.net/https://github.com/Three-LEI/CEP-ZH/releases/download/',
    'https://github.com/Three-LEI/CEP-ZH/releases/download/'
  ];
  let lastError = null;
  for (const prefix of prefixes) {
    try {
      const url = prefix + 'v' + version + '/CepZhInstaller.exe';
      const buffer = await httpsBuffer(url);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (hash.toLowerCase() !== String(manifest.installerSha256).toLowerCase()) {
        throw new Error('安装器 SHA-256 不匹配');
      }
      const dir = path.join(os.tmpdir(), 'CEP-ZH-update');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'CepZhInstaller-' + version + '.exe');
      fs.writeFileSync(file, buffer);
      return file;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('安装器下载失败');
}

async function runUpdateTask(task) {
  if (!task || !task.token || updateRunning) return;
  lastUpdateToken = task.token;
  if (Date.now() - (task.requestedAt || 0) > 120000) {
    updateState = { token: task.token, status: 'error', message: '更新请求已过期', version: '' };
    writeState(panelState(lastLive));
    return;
  }
  updateRunning = true;
  updateState = { token: task.token, status: 'checking', message: '正在获取更新清单', version: '' };
  writeState(panelState(lastLive));
  try {
    const manifest = await fetchSignedManifest();
    updateState = {
      token: task.token, status: 'downloading', version: manifest.version,
      message: '正在下载安装器 v' + manifest.version,
    };
    writeState(panelState(lastLive));
    const file = await downloadInstaller(manifest);
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    updateState = {
      token: task.token, status: 'launched', version: manifest.version,
      message: '安装器已启动，请按提示关闭 Adobe 应用',
    };
    lastUpdateToken = task.token;
    log('[update] installer launched', manifest.version);
  } catch (err) {
    updateState = {
      token: task.token, status: 'error', version: '',
      message: '更新失败：' + err.message,
    };
    log('[update] failed', err.message);
  } finally {
    updateRunning = false;
    writeState(panelState(lastLive));
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
    if (control.updateTask && control.updateTask.token !== lastUpdateToken && !updateRunning) {
      runUpdateTask(control.updateTask).catch((err) => log('[update] failed', err.message));
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
    refreshDebugBaseline();
    const remaining = pendingDebug().length;
    const status = remaining === 0 ? 'done' : (code !== 0 ? 'error' : (needElevate ? 'elevated' : 'error'));
    lastRepair = {
      token, at: new Date().toISOString(), status, total, remaining,
      elevated: needElevate,
      message: status === 'done'
        ? '已写入 .debug，请重启 Adobe 应用'
        : (status === 'elevated'
          ? '已请求管理员写入系统目录；完成后请重启 Adobe 应用'
          : (code !== 0
            ? '管理员写入未完成或已取消，请重试'
            : `仍有 ${remaining} 个插件未写入，请查看日志`)),
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
    refreshDebugBaseline();
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

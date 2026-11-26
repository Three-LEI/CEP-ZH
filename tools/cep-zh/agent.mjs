// cep-zh agent: discover CEP panels, inject runtime, collect words, honor control.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';

import { scanExtensions, detectInstalledHosts } from './lib/scan.mjs';
import { buildPortIndex, discoverLivePanels, resolveLiveTarget } from './lib/live.mjs';
import { loadDictionaries, buildConfigFor, dictionaryRoots, dictionaryKeysFor } from './lib/dict.mjs';
import { attach, reinject, evaluateOn, readStats } from './lib/inject.mjs';
import { listTargets, connect, evaluate } from './lib/cdp.mjs';
import { EXTRACT_EXPR, mergeCatalog, saveCatalog, catalogPathFor } from './lib/catalog.mjs';
import { isTranslatable, loadTranslationConfig, translateStrings } from './lib/translate-api.mjs';
import { loadState } from './lib/ports.mjs';
import { loadDebugBaseline, writeDebugBaseline } from './lib/baseline.mjs';
import { canWriteDir, listLoopbackListeningPorts } from './lib/net.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = path.join(TOOL_DIR, 'catalog');
const USER_ROOT = process.env.APPDATA ? path.join(process.env.APPDATA, 'CEP-ZH') : path.join(TOOL_DIR, 'userdata');
const USER_DICT_DIR = path.join(USER_ROOT, 'dict');
const USER_EXT_DIR = path.join(USER_DICT_DIR, 'extensions');
const CONTROL_PATH = path.join(USER_ROOT, 'control.json');
const STATE_PATH = path.join(USER_ROOT, 'state.json');
const BASELINE_PATH = path.join(USER_ROOT, 'debug-baseline.json');
const CLI_PATH = path.join(TOOL_DIR, 'cli.mjs');
// "Immediate" profile: a hint is captured 300 ms after detection.
const AUTO_CAPTURE_DEBOUNCE_MS = 300;
// Per-plugin intervals: the plugin selected in the manager is captured fastest,
// background panels slower, hidden panels slowest (they are pre-captured, not
// watched). lastAutoCaptureAt is per session, so these are genuinely per plugin.
const AUTO_CAPTURE_MIN_INTERVAL_MS = 2500;
const SELECTED_CAPTURE_MIN_INTERVAL_MS = 1200;
const HIDDEN_CAPTURE_MIN_INTERVAL_MS = 6000;
// A failed or deferred capture retries with 1.5 s / 3 s / 4.5 s backoff.
const AUTO_RETRY_BASE_MS = 1500;
// After a 0-word capture, look again shortly: panels often render the new page
// after our 300 ms capture window.
const AUTO_VERIFY_MS = 1500;
// Slow panels (VHSCam updates its label after an ExtendScript round trip) may
// need a few checks; give the page ~6 s before falling back to the safety net.
const AUTO_MAX_VERIFIES = 4;
const AUTO_MAX_ATTEMPTS = 3;
// Safety net for page switches that emit no hint at all (or render too late).
const SAFETY_CAPTURE_MS = 9000;
const SAFETY_MIN_GAP_MS = 4000;
// Auto-capture keeps a persistent trace because the hidden panel spawns this
// agent with stdio ignored: its stdout is discarded, so reproduction evidence
// has to land in a file. Kept small and rotated; never fatal on write errors.
const AUTO_LOG_PATH = path.join(USER_ROOT, 'auto-capture.log');
const AUTO_LOG_MAX_BYTES = 2 * 1024 * 1024;
// Only an idle heartbeat uses this throttle; activity and capture lines are
// event-driven. A quiet panel therefore costs one line per 5 minutes.
const AUTO_LOG_HEARTBEAT_MS = 300000;
// Panel discovery spawns tasklist+netstat (~160 ms on this machine), so it runs
// on its own slower cadence than the 1 s session polling.
const DISCOVER_INTERVAL_MS = 4000;
// Fast path: netstat alone (~15 ms) every 500 ms notices a panel that just
// opened; only ports that are (a) listening and (b) not probed yet are hit with
// an HTTP /json probe, so a closed .debug port costs nothing.
const PROBE_TICK_MS = 500;
const PROBE_TIMEOUT_MS = 250;
// Initial injection of several newly opened panels runs a few at a time instead
// of strictly one-by-one, which halves Adobe-startup warm-up on 5+ panels.
const INJECT_CONCURRENCY = 3;

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

let lastAutoCapture = null;
let autoLogWrites = 0;
let firstTick = true;
let lastDiscoverAt = 0;
const noOriginalsLogged = new WeakSet();

function sessionLabel(session) {
  if (!session) return ':?';
  const id = session.bundle?.bundleId || session.extId || '';
  return ':' + session.port + (id ? ' ' + String(id) : '');
}

function clip(value, max = 140) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// One line, one event: "<local iso> [auto] :8092 bundle event detail". Local
// time with an explicit offset, so a trace lines up with what the user did.
function autoTimestamp() {
  const d = new Date();
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function autoLog(session, event, detail = '') {
  // control.json can silence the file log (autoCaptureLog:false); it stays on by
  // default because this trace is the only record the hidden panel cannot keep.
  if (control && control.autoCaptureLog === false) return;
  const line = autoTimestamp() + ' [auto] ' + sessionLabel(session) + ' ' + event + (detail ? ' ' + detail : '');
  try {
    fs.mkdirSync(USER_ROOT, { recursive: true });
    fs.appendFileSync(AUTO_LOG_PATH, line + '\r\n');
    autoLogWrites++;
    if (autoLogWrites % 100 === 0) {
      const st = fs.statSync(AUTO_LOG_PATH);
      if (st.size > AUTO_LOG_MAX_BYTES) {
        // Rename can fail when a tail/editor/AV holds the file; truncate instead
        // so the log can never grow without bound.
        try { fs.renameSync(AUTO_LOG_PATH, AUTO_LOG_PATH + '.1'); } catch { try { fs.truncateSync(AUTO_LOG_PATH, 0); } catch {} }
      }
    }
  } catch { /* logging must never break capture */ }
  if (args.verbose || process.stdout.isTTY) console.log(line);
}

function autoLogThrottled(session, event, detail, ms = AUTO_LOG_HEARTBEAT_MS) {
  if (!session) { autoLog(session, event, detail); return; }
  if (!session.autoLogThrottle) session.autoLogThrottle = new Map();
  const now = Date.now();
  if (now - (session.autoLogThrottle.get(event) || 0) < ms) return;
  session.autoLogThrottle.set(event, now);
  autoLog(session, event, detail);
}

function autoLogOnce(session, event, detail) {
  if (!session) { autoLog(session, event, detail); return; }
  if (!session.autoLogOnce) session.autoLogOnce = new Set();
  if (session.autoLogOnce.has(event)) return;
  session.autoLogOnce.add(event);
  autoLog(session, event, detail);
}

// Last auto-capture outcome, persisted in state.json even when it added 0 words.
function recordAutoCapture(patch) {
  lastAutoCapture = Object.assign({ at: autoTimestamp() }, patch);
  return lastAutoCapture;
}

function autoEpochOf(session) {
  return Number(session?.stats?.activityEpoch) || 0;
}
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
let lastTestToken = '';
let apiTest = null;
let lastRepairToken = '';
let lastRepair = null;
let lastMaintainToken = '';
let lastMaintain = null;
let lastAutoDebug = null;
let autoDebugRepairing = false;
const autoDebugAttempted = new Set();
let translation = {
  running: false, token: '', scope: '', bundleId: '',
  total: 0, done: 0, translated: 0, skipped: 0, unchanged: 0,
  error: '', startedAt: '', finishedAt: '', auto: false,
};
// Auto-translate: new words land in a per-bundle queue, then run one bundle at a
// time through the same pipeline the manager's "AI 翻译" button uses.
const AUTO_TRANSLATE_DEBOUNCE_MS = 1200;
const autoTranslatePending = new Map(); // bundleKey -> { added, at }
const autoTranslateUnchanged = new Map(); // bundleKey -> Set(word) the API echoed
let autoTranslateTimer = null;
let autoTranslateMissingAt = 0;
let autoTranslateState = {
  enabled: false, status: 'idle', message: '', bundleId: '',
  bundles: [], queued: 0, lastTranslated: 0, at: '',
};

function readControl() {
  try {
    const j = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8').replace(/^\uFEFF/, ''));
    const t = j.translationTask;
    const test = j.testApiTask;
    const maintain = j.maintainTask;
    return {
      enabled: j.enabled !== false,
      autoCapture: j.autoCapture !== false,
      autoTranslate: j.autoTranslate === true,
      autoCaptureLog: j.autoCaptureLog !== false,
      captureSelected: j.captureSelected === true,
      captureViewportOnly: j.captureViewportOnly === true,
      selectedBundle: String(j.selectedBundle || ''),
      disabledPlugins: Array.isArray(j.disabledPlugins) ? j.disabledPlugins.map(String) : [],
      collectToken: j.collectToken ? String(j.collectToken) : '',
      repairDebugToken: j.repairDebugToken ? String(j.repairDebugToken) : '',
      repairDebugRequestedAt: Number(j.repairDebugRequestedAt) || 0,
      testApiTask: test && test.token ? {
        token: String(test.token),
        requestedAt: Number(test.requestedAt) || 0,
      } : null,
      translationTask: t && t.token ? {
        token: String(t.token),
        scope: t.scope === 'all' ? 'all' : 'plugin',
        bundleId: String(t.bundleId || ''),
      } : null,
      maintainTask: maintain && maintain.token ? {
        token: String(maintain.token),
        scope: maintain.scope === 'all' ? 'all' : 'plugin',
        bundleId: String(maintain.bundleId || ''),
      } : null,
    };
  } catch {
    return {
      enabled: true, autoCapture: true, autoTranslate: false, captureSelected: false,
      captureViewportOnly: false, selectedBundle: '', disabledPlugins: [], collectToken: '',
      repairDebugToken: '', repairDebugRequestedAt: 0, testApiTask: null, translationTask: null,
      maintainTask: null,
    };
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

function sessionMatchesSelected(session, want) {
  const key = pluginKey(session.bundle, session.extId).toLowerCase();
  if (!want) return false;
  if (key === want) return true;
  return pluginIds(session.bundle, session.extId).some((id) => id.toLowerCase() === want);
}

function selectedIsLive() {
  const want = String(control.selectedBundle || '').toLowerCase();
  if (!want) return false;
  for (const session of sessions.values()) {
    if (sessionMatchesSelected(session, want)) return true;
  }
  return false;
}

/**
 * "Only capture the selected plugin" is a preference, not a starvation rule:
 * when the selected plugin has no live panel (or nothing is selected), every
 * panel stays eligible.
 */
function captureTargetOk(session) {
  if (!control.captureSelected) return true;
  const want = String(control.selectedBundle || '').toLowerCase();
  if (!want) return true;
  if (!selectedIsLive()) return true;
  return sessionMatchesSelected(session, want);
}

function isSelectedSession(session) {
  if (!control.selectedBundle) return false;
  return sessionMatchesSelected(session, String(control.selectedBundle).toLowerCase());
}

/** Per-plugin capture interval: selected > background > hidden. */
function captureIntervalMs(session) {
  if (isSelectedSession(session)) return SELECTED_CAPTURE_MIN_INTERVAL_MS;
  if (session?.stats?.hidden) return HIDDEN_CAPTURE_MIN_INTERVAL_MS;
  return AUTO_CAPTURE_MIN_INTERVAL_MS;
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
      autoCapture: control.autoCapture,
      disabledPlugins: control.disabledPlugins,
      lastCollect,
      translation,
      apiTest,
      pendingDebug: pendingDebug(),
      lastRepair,
      lastMaintain,
      lastAutoDebug,
      lastAutoCapture,
      autoTranslate: autoTranslateState,
      captureOptions: {
        selectedOnly: !!control.captureSelected,
        viewportOnly: !!control.captureViewportOnly,
        selectedBundle: control.selectedBundle || '',
      },
      pluginNames: pluginNameMap(),
      autoCaptureRuntime: { translationRunning, sessions: sessions.size },
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
  // Keep the manager's status in sync with the panel's actual state.
  try { session.stats = await readStats(session.client); } catch {}
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
        autoLog(session, 'off', 'reason=control');
      } else if (!desiredDisabled && session.translationDisabled) {
        try {
          await reinject(session, configFor(session.port, session.bundle, session.extId));
          session.translationDisabled = false;
          log(`[on]  :${session.port} ${session.bundle?.bundleId || session.extId || ''}`);
          autoLog(session, 'reinject', `reason=control changed=${session.stats?.changed ?? '?'}`);
          // Our own reinject restarts the runtime's mutation counter; without
          // resetting this baseline the verify check would fire on the reset.
          session.lastCapturedMutations = Number(session.stats?.mutations) || 0;
          session.verifyAt = 0;
          session.verifyTries = 0;
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
  // Strip a UTF-8 BOM: JSON.parse rejects it and a BOM'd dictionary would look empty.
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

/** Display name registered in the extension manifest (<Menu>), e.g. "Motion 4". */
function manifestDisplayName(bundle) {
  for (const ext of bundle?.extensions || []) {
    const menu = String(ext.menu || '').trim();
    // '%CCX_START_PANEL_NAME' style entries are localization keys, not names.
    if (!menu || menu === ext.id || menu.charAt(0) === '%') continue;
    return menu;
  }
  return '';
}

/** bundleId -> registered display name, so the manager can list friendly names. */
function pluginNameMap() {
  const out = {};
  for (const bundle of scan.bundles) {
    const id = String(bundle?.bundleId || '');
    if (!id || id.startsWith('cep.zh.')) continue;
    const name = manifestDisplayName(bundle);
    if (name) out[id] = name;
  }
  return out;
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

function translationCandidates(keys, skipMap) {
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
    const todo = [];
    const skip = skipMap ? skipMap.get(key) : null;
    const candidates = new Set([...Object.keys(user.strings), ...Object.keys(existing)]);
    for (const s of candidates) {
      if (skip && skip.has(s)) { skipped++; continue; }
      if (user.strings[s] || existing[s]) { skipped++; continue; }
      if (!isTranslatable(s)) { skipped++; continue; }
      todo.push(s);
      all.add(s);
    }
    if (todo.length) perKey.push({ key, user, todo });
  }
  return { perKey, strings: [...all], skipped };
}

/**
 * Write the API result into every affected dictionary file.
 * Auto mode additionally remembers the strings the API echoed unchanged (in
 * memory for skipping and in the dictionary file for the maintenance action).
 */
function applyTranslationMap(perKey, map, { isAuto = false } = {}) {
  let translated = 0;
  let unchanged = 0;
  const changedKeys = [];
  for (const item of perKey) {
    let changed = false;
    let listChanged = false;
    const unchangedSet = new Set(Array.isArray(item.user.unchanged) ? item.user.unchanged.map(String) : []);
    for (const s of item.todo) {
      if (!map[s]) continue;
      if (String(map[s]).trim().toLowerCase() === String(s).trim().toLowerCase()) {
        unchanged++;
        if (isAuto) {
          rememberUnchanged(item.key, s);
          if (!unchangedSet.has(s)) { unchangedSet.add(s); listChanged = true; }
        }
        continue;
      }
      item.user.strings[s] = map[s];
      translated++;
      changed = true;
      if (unchangedSet.delete(s)) listChanged = true;
    }
    if (listChanged) item.user.unchanged = [...unchangedSet].slice(-1000);
    if (changed || listChanged) {
      item.user.name = item.user.name || item.key;
      fs.writeFileSync(path.join(USER_EXT_DIR, item.key + '.json'), JSON.stringify(item.user, null, 2), 'utf8');
      changedKeys.push(item.key);
    }
  }
  return { translated, unchanged, changedKeys };
}

async function runTranslationTask(task) {
  if (translationRunning) return;
  translationRunning = true;
  const isAuto = !!task.auto;
  translation = {
    running: true, token: task.token, scope: task.scope, bundleId: task.bundleId,
    total: 0, done: 0, translated: 0, skipped: 0, unchanged: 0,
    error: '', startedAt: new Date().toISOString(), finishedAt: '', auto: isAuto,
  };
  if (isAuto) {
    setAutoTranslateState({ status: 'translating', message: '正在翻译', bundleId: task.bundleId, queued: autoTranslatePending.size });
  }
  writeState(panelState(lastLive));
  log(`[translate] start scope=${task.scope} bundle=${task.bundleId || 'all'}${isAuto ? ' auto=true' : ''}`);
  try {
    const cfg = loadTranslationConfig();
    if (!cfg.provider || cfg.provider === 'none') throw new Error('翻译 API 未配置，请先在设置里填写 provider / Key');
    const keys = translationKeys(task);
    if (!keys.length) throw new Error('没有可翻译的插件字典');
    // Auto mode skips words the API already echoed unchanged, so an unchanged
    // label is not re-sent on every new capture.
    const { perKey, strings, skipped } = translationCandidates(keys, isAuto ? autoTranslateUnchanged : null);
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
    const applied = applyTranslationMap(perKey, map, { isAuto });
    translation.translated = applied.translated;
    translation.unchanged = applied.unchanged;
    log(`[translate] done translated=${applied.translated} skipped=${skipped} unchanged=${applied.unchanged}${isAuto ? ' auto=true' : ''}`);
  } catch (err) {
    translation.error = err.message;
    log('[translate] error:', err.message);
  } finally {
    translation.running = false;
    translation.finishedAt = new Date().toISOString();
    translationRunning = false;
    // Do NOT assign dicts = loadDictionaries() here: that would swallow the
    // signature difference the reload check relies on, and the freshly written
    // translations would never be re-injected into the live panels (they only
    // appeared after toggling the switch). reloadDictionaries() reloads and
    // re-injects in one step.
    try {
      await reloadDictionaries();
    } catch (err) {
      log('[dict] reload after translation failed:', err.message);
      dicts = loadDictionaries();
    }
    if (isAuto) {
      setAutoTranslateState({
        status: translation.error ? 'error' : 'done',
        message: translation.error || ('新词翻译 ' + translation.translated + ' 条'),
        bundleId: task.bundleId,
        lastTranslated: translation.translated,
        queued: autoTranslatePending.size,
      });
      autoLog(null, 'auto-translate-done', `bundle=${task.bundleId || '?'} translated=${translation.translated} unchanged=${translation.unchanged} skipped=${translation.skipped} error="${clip(translation.error, 120)}"`);
    }
    writeState(panelState(lastLive));
  }
}

function setAutoTranslateState(patch) {
  autoTranslateState = Object.assign({}, autoTranslateState, { at: autoTimestamp() }, patch || {});
  autoTranslateState.enabled = !!control.autoTranslate;
  autoTranslateState.queued = autoTranslatePending.size;
  autoTranslateState.bundles = [...autoTranslatePending.keys()].slice(0, 12);
  return autoTranslateState;
}

function rememberUnchanged(key, word) {
  let set = autoTranslateUnchanged.get(key);
  if (!set) { set = new Set(); autoTranslateUnchanged.set(key, set); }
  set.add(word);
}

function translationProviderNow() {
  const cfg = loadTranslationConfig();
  const provider = String(cfg.provider || '').toLowerCase();
  return (!provider || provider === 'none') ? '' : provider;
}

/** Called whenever a capture added words: queue the plugin for auto translation. */
function queueAutoTranslate(key, added) {
  if (!control.autoTranslate) return;
  if (!key || key === 'unknown' || key.startsWith('cep.zh.')) return;
  const provider = translationProviderNow();
  if (!provider) {
    // Only surface "API missing" once a minute so a busy panel cannot spam the
    // manager with identical toasts.
    const now = Date.now();
    if (autoTranslateState.status !== 'api-missing' || now - autoTranslateMissingAt > 60000) {
      autoTranslateMissingAt = now;
      setAutoTranslateState({ status: 'api-missing', message: '翻译 API 未启用', bundleId: key });
      autoLog(null, 'auto-translate-skip', `reason=api-missing bundle=${key}`);
    }
    return;
  }
  const prev = autoTranslatePending.get(key);
  autoTranslatePending.set(key, { added: (prev?.added || 0) + added, at: Date.now() });
  setAutoTranslateState({ status: 'queued', message: '等待翻译', bundleId: key, lastTranslated: autoTranslateState.lastTranslated });
  autoLog(null, 'auto-translate-queue', `bundle=${key} added=${added} provider=${provider} queued=${autoTranslatePending.size}`);
  scheduleAutoTranslateRun();
}

function scheduleAutoTranslateRun(delay = AUTO_TRANSLATE_DEBOUNCE_MS) {
  if (!control.autoTranslate) return;
  if (autoTranslateTimer) clearTimeout(autoTranslateTimer);
  autoTranslateTimer = setTimeout(() => {
    autoTranslateTimer = null;
    runAutoTranslate().catch((err) => {
      autoLog(null, 'auto-translate-error', `err=${clip(err.message, 120)}`);
    });
  }, delay);
}

async function runAutoTranslate() {
  if (!control.autoTranslate) {
    autoTranslatePending.clear();
    setAutoTranslateState({ status: 'idle', message: '已关闭' });
    return;
  }
  if (!autoTranslatePending.size) return;
  if (translationRunning) {
    // Another translation owns the API right now; retry when it should be done.
    setAutoTranslateState({ status: 'queued', message: '等待上一个翻译任务结束' });
    scheduleAutoTranslateRun(3000);
    return;
  }
  const keys = [...autoTranslatePending.keys()];
  autoTranslatePending.clear();
  await runAutoTranslateBatch(keys);
}

/**
 * Translate the words of several plugins in ONE request. The API cost and the
 * wait are per request, so batching N plugins is N× cheaper than looping.
 */
async function runAutoTranslateBatch(keys) {
  if (translationRunning) return false;
  const cleanKeys = [...new Set((keys || []).map(String))]
    .filter((k) => k && !k.startsWith('cep.zh.'));
  if (!cleanKeys.length) return false;
  translationRunning = true;
  const token = 'auto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  translation = {
    running: true, token, scope: 'auto', bundleId: cleanKeys[0],
    bundles: cleanKeys.slice(), total: 0, done: 0, translated: 0, skipped: 0, unchanged: 0,
    error: '', startedAt: new Date().toISOString(), finishedAt: '', auto: true,
  };
  setAutoTranslateState({ status: 'translating', message: '正在翻译', bundleId: cleanKeys[0], queued: autoTranslatePending.size });
  writeState(panelState(lastLive));
  autoLog(null, 'auto-translate-start', `bundles=${cleanKeys.length} queue=${autoTranslatePending.size} list=${clip(cleanKeys.join(','), 160)}`);
  try {
    const cfg = loadTranslationConfig();
    if (!cfg.provider || cfg.provider === 'none') throw new Error('翻译 API 未配置，请先在设置里填写 provider / Key');
    const { perKey, strings, skipped } = translationCandidates(cleanKeys, autoTranslateUnchanged);
    translation.total = strings.length;
    translation.skipped = skipped;
    writeState(panelState(lastLive));
    if (!strings.length) {
      log('[translate] nothing to translate (auto)');
    } else {
      const map = await translateStrings(cfg, strings, {
        onProgress(done, total) {
          translation.done = done;
          translation.total = total;
          writeState(panelState(lastLive));
        },
      });
      const applied = applyTranslationMap(perKey, map, { isAuto: true });
      translation.translated = applied.translated;
      translation.unchanged = applied.unchanged;
      log(`[translate] done auto bundles=${cleanKeys.length} translated=${applied.translated} skipped=${skipped} unchanged=${applied.unchanged}`);
    }
  } catch (err) {
    translation.error = err.message;
    log('[translate] error:', err.message);
  } finally {
    translation.running = false;
    translation.finishedAt = new Date().toISOString();
    translationRunning = false;
    try {
      await reloadDictionaries();
    } catch (err) {
      log('[dict] reload after translation failed:', err.message);
      dicts = loadDictionaries();
    }
    setAutoTranslateState({
      status: translation.error ? 'error' : 'done',
      message: translation.error || ('新词翻译 ' + translation.translated + ' 条'),
      bundleId: cleanKeys[0],
      lastTranslated: translation.translated,
      queued: autoTranslatePending.size,
    });
    autoLog(null, 'auto-translate-done', `bundles=${cleanKeys.length} translated=${translation.translated} unchanged=${translation.unchanged} skipped=${translation.skipped} error="${clip(translation.error, 120)}"`);
    writeState(panelState(lastLive));
  }
  return true;
}

async function runApiTestTask(task) {
  if (translationRunning) {
    apiTest = {
      token: task.token, status: 'error', message: '翻译任务进行中，请稍后再测试',
      provider: '', model: '', at: new Date().toISOString(),
    };
    writeState(panelState(lastLive));
    return;
  }
  let cfg = {};
  apiTest = {
    token: task.token, status: 'running', message: '正在请求翻译 API…',
    provider: '', model: '', at: new Date().toISOString(),
  };
  writeState(panelState(lastLive));
  try {
    cfg = loadTranslationConfig();
    if (!cfg.provider || cfg.provider === 'none') throw new Error('翻译 API 未配置');
    const sample = 'Test connection';
    const map = await translateStrings(cfg, [sample], {});
    const text = map[sample];
    if (!text) throw new Error('API 返回空翻译');
    apiTest = {
      token: task.token, status: 'ok', message: '连接成功：' + String(text).slice(0, 80),
      provider: cfg.provider, model: cfg.model || '', at: new Date().toISOString(),
    };
    log(`[test] ok provider=${cfg.provider}`);
  } catch (err) {
    apiTest = {
      token: task.token, status: 'error', message: err.message,
      provider: cfg.provider || '', model: cfg.model || '', at: new Date().toISOString(),
    };
    log('[test] error:', err.message);
  } finally {
    writeState(panelState(lastLive));
  }
}


/**
 * Conservative dictionary maintenance for one plugin:
 * - drop empty entries whose translation was echoed unchanged by the API
 *   (they will never be translated; they only clutter the list);
 * - merge whitespace/case duplicates when keeping one entry is equivalent
 *   (exactly one translated, or all translations identical).
 * Everything else is left untouched.
 */
function maintainDictionary(key) {
  const file = path.join(USER_EXT_DIR, key + '.json');
  const user = readJsonSafe(file, null);
  if (!user || !user.strings) return { key, changed: false, removedEmpty: 0, removedDup: 0, entries: 0 };
  const unchanged = new Set(Array.isArray(user.unchanged) ? user.unchanged.map(String) : []);
  let removedEmpty = 0;
  let removedDup = 0;
  for (const word of Object.keys(user.strings)) {
    if (user.strings[word]) continue;
    if (!unchanged.has(word)) continue;
    delete user.strings[word];
    unchanged.delete(word);
    removedEmpty++;
  }
  const groups = new Map();
  for (const word of Object.keys(user.strings)) {
    const norm = word.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!norm) continue;
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(word);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const translated = list.filter((w) => !!user.strings[w]);
    let keep = null;
    if (translated.length === 1) keep = translated[0];
    else if (translated.length === 0) keep = list[0];
    else if (new Set(translated.map((w) => String(user.strings[w]))).size === 1) keep = translated[0];
    if (!keep) continue;
    for (const w of list) {
      if (w === keep) continue;
      delete user.strings[w];
      unchanged.delete(w);
      removedDup++;
    }
  }
  const nextUnchanged = [...unchanged].filter((w) => Object.prototype.hasOwnProperty.call(user.strings, w) && !user.strings[w]);
  const prevListLen = Array.isArray(user.unchanged) ? user.unchanged.length : 0;
  const listChanged = nextUnchanged.length !== prevListLen;
  if (nextUnchanged.length) user.unchanged = nextUnchanged.slice(-1000);
  else delete user.unchanged;
  const changed = removedEmpty + removedDup > 0 || listChanged;
  if (changed) fs.writeFileSync(file, JSON.stringify(user, null, 2), 'utf8');
  return { key, changed, removedEmpty, removedDup, entries: Object.keys(user.strings).length };
}

async function runMaintainTask(task) {
  lastMaintain = {
    token: task.token, at: new Date().toISOString(), status: 'running',
    message: '正在整理', removed: 0, deduped: 0, dictionaries: 0,
  };
  writeState(panelState(lastLive));
  if (translationRunning) {
    lastMaintain = {
      token: task.token, at: new Date().toISOString(), status: 'error',
      message: '翻译任务进行中，请稍后再整理', removed: 0, deduped: 0, dictionaries: 0,
    };
    writeState(panelState(lastLive));
    return;
  }
  try {
    const keys = translationKeys(task);
    if (!keys.length) throw new Error('没有可整理的插件字典');
    let removed = 0;
    let deduped = 0;
    let touched = 0;
    for (const key of keys) {
      const r = maintainDictionary(key);
      removed += r.removedEmpty;
      deduped += r.removedDup;
      if (r.changed) touched++;
    }
    lastMaintain = {
      token: task.token, at: new Date().toISOString(), status: 'done',
      removed, deduped, dictionaries: touched,
      message: `清理 ${removed} 条无用词条，合并 ${deduped} 条重复词条（${touched} 个字典）`,
    };
    log(`[maintain] done keys=${keys.length} removed=${removed} deduped=${deduped} touched=${touched}`);
    autoLog(null, 'maintain', `keys=${keys.length} removed=${removed} deduped=${deduped} touched=${touched}`);
    await reloadDictionaries();
  } catch (err) {
    lastMaintain = {
      token: task.token, at: new Date().toISOString(), status: 'error',
      message: err.message, removed: 0, deduped: 0, dictionaries: 0,
    };
    log('[maintain] error:', err.message);
    autoLog(null, 'maintain-error', `err=${clip(err.message, 120)}`);
  } finally {
    dicts = loadDictionaries();
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
    const autoChanged = next.autoCapture !== control.autoCapture;
    const autoTranslateChanged = next.autoTranslate !== control.autoTranslate;
    control = next;
    if (autoChanged) {
      autoLog(null, 'control', `autoCapture=${control.autoCapture}`);
      if (!control.autoCapture) {
        for (const session of sessions.values()) {
          if (session.autoCaptureTimer) {
            clearTimeout(session.autoCaptureTimer);
            autoLog(session, 'timer-cancelled', 'reason=auto-off');
          }
          session.autoCaptureTimer = null;
        }
      } else {
        // Re-enabling should log the "auto-off" state again on the next disable.
        for (const session of sessions.values()) {
          if (session.autoLogOnce) session.autoLogOnce.delete('poll-auto-off');
        }
      }
    }
    if (autoTranslateChanged) {
      autoLog(null, 'control', `autoTranslate=${control.autoTranslate}`);
      if (!control.autoTranslate) {
        autoTranslatePending.clear();
        if (autoTranslateTimer) { clearTimeout(autoTranslateTimer); autoTranslateTimer = null; }
        setAutoTranslateState({ status: 'idle', message: '已关闭' });
      } else {
        const provider = translationProviderNow();
        setAutoTranslateState({
          status: provider ? 'idle' : 'api-missing',
          message: provider ? '已开启，等待新词条' : '翻译 API 未启用',
        });
      }
      writeState(panelState(lastLive));
    }
    if (changed) await applyControl();
    if (control.translationTask && control.translationTask.token !== lastTranslationToken) {
      lastTranslationToken = control.translationTask.token;
      if (!translationRunning) {
        runTranslationTask(control.translationTask).catch((err) => log('[translate] failed', err.message));
      }
    }
    if (control.testApiTask && control.testApiTask.token !== lastTestToken) {
      lastTestToken = control.testApiTask.token;
      runApiTestTask(control.testApiTask).catch((err) => log('[test] failed', err.message));
    }
    if (control.maintainTask && control.maintainTask.token !== lastMaintainToken) {
      lastMaintainToken = control.maintainTask.token;
      runMaintainTask(control.maintainTask).catch((err) => log('[maintain] failed', err.message));
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

function mergeWordsIntoDict(key, extracted, diag) {
  ensureUserDirs();
  const d = diag || {};
  const file = path.join(USER_EXT_DIR, key + '.json');
  let dict = { name: key, strings: {}, patterns: [] };
  try { dict = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  if (!dict.strings) dict.strings = {};
  if (!Array.isArray(dict.patterns)) dict.patterns = [];
  const covered = existingTranslationSet(key);
  let added = 0;
  const words = new Set([
    ...(extracted.text || []).map((x) => x[0]),
    ...(extracted.attrs || []).map((x) => x[0]),
  ]);
  // Filters are counted so a 0-word capture can be told apart from an empty DOM.
  d.words = words.size;
  d.skippedNotTranslatable = 0;
  d.skippedCovered = 0;
  d.skippedAlreadyListed = 0;
  d.pendingUntranslated = 0;
  for (const word of words) {
    if (!isTranslatable(word)) { d.skippedNotTranslatable++; continue; }
    if (!word || covered.has(word)) { d.skippedCovered++; continue; }
    if (Object.prototype.hasOwnProperty.call(dict.strings, word)) {
      d.skippedAlreadyListed++;
      // Known word without a translation (captured earlier, never translated):
      // it still needs a translation pass even though nothing was "added".
      if (!dict.strings[word]) d.pendingUntranslated++;
      continue;
    }
    dict.strings[word] = '';
    added++;
  }
  d.added = added;
  if (added) {
    fs.writeFileSync(file, JSON.stringify(dict, null, 2), 'utf8');
    dicts = loadDictionaries();
    log(`[collect] ${key} +${added} words -> ${path.relative(USER_ROOT, file)}`);
  }
  return added;
}

// The runtime keeps the English source of everything it translated, so a capture
// reads those instead of calling off(). That removes the English frame entirely
// and keeps the panel untouched; the whole read is still one CDP evaluation.
// `viewportOnly` makes EXTRACT skip content outside the visible area.
function buildExtractExpression() {
  return '(function () {' +
    'var z = window.__CEP_ZH__;' +
    'var wasOn = false, mutations = 0, extractError = "", out = null, textLen = 0;' +
    'window.__CEP_ZH_EXTRACT_OPTS__ = { viewportOnly: ' + (control.captureViewportOnly ? 'true' : 'false') + ' };' +
    'try { var st = (z && z.stats) ? z.stats() : null; wasOn = !!(st && st.enabled); mutations = st ? (Number(st.mutations) || 0) : 0; } catch (e) {}' +
    'try {' +
    '  out = (' + EXTRACT_EXPR + ');' +
    '  textLen = (document.body && document.body.textContent) ? document.body.textContent.length : 0;' +
    '} catch (e) { extractError = String(e && e.message || e); }' +
    'return { raw: out, wasOn: wasOn, mutations: mutations, textLen: textLen, extractError: extractError, hasOriginals: !!(z && z.originalTextFor) };' +
    '})()';
}

async function extractOriginals(client, diag) {
  // Writes what the extraction actually did into `diag` so a failed extraction
  // can be told apart from an empty or fully-covered panel.
  const d = diag || {};
  const startedAt = Date.now();
  let payload = null;
  try {
    payload = await evaluate(client, buildExtractExpression());
  } catch (err) {
    d.extractError = err.message;
  }
  let raw = null;
  if (payload && typeof payload === 'object') {
    d.wasOn = !!payload.wasOn;
    d.hasOriginals = !!payload.hasOriginals;
    if (typeof payload.textLen === 'number') d.textLen = payload.textLen;
    if (typeof payload.mutations === 'number') d.mutations = payload.mutations;
    if (payload.extractError) d.extractError = payload.extractError;
    if (typeof payload.raw === 'string' && payload.raw) raw = payload.raw;
  }
  if (payload && typeof payload === 'object' && !payload.hasOriginals && !noOriginalsLogged.has(client)) {
    // 1.3.0+ exposes originalTextFor(); without it a translated panel only yields
    // Chinese text and captures nothing, so say it out loud once per panel.
    noOriginalsLogged.add(client);
    autoLog(null, 'runtime-no-originals', 'capture sees translated text only; re-inject the panel');
  }
  d.extractMs = Date.now() - startedAt;
  d.rawLength = raw ? String(raw).length : 0;
  return raw;
}

async function collectSession(session, diag) {
  if (!session || session.captureBusy) return 0;
  const d = diag || {};
  session.captureBusy = true;
  const startedAt = Date.now();
  try {
    const key = pluginKey(session.bundle, session.extId);
    const raw = await extractOriginals(session.client, d);
    if (!raw) { d.result = 'extract-null'; return 0; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      d.result = 'parse-error';
      d.error = err.message;
      return 0;
    }
    d.text = Array.isArray(parsed.text) ? parsed.text.length : 0;
    d.attrs = Array.isArray(parsed.attrs) ? parsed.attrs.length : 0;
    if (parsed.rejected) d.rejected = parsed.rejected;
    if (parsed.dom) d.dom = parsed.dom;
    const added = mergeWordsIntoDict(key, parsed, d);
    d.result = 'ok';
    // A known-but-untranslated word also needs the translation pass: switching to
    // an already-captured page used to leave it English forever.
    if (added || (d.pendingUntranslated || 0) > 0) queueAutoTranslate(key, added || d.pendingUntranslated || 0);
    return added;
  } catch (err) {
    d.result = 'error';
    d.error = err.message;
    throw err;
  } finally {
    d.captureMs = Date.now() - startedAt;
    session.captureBusy = false;
  }
}

function describeDiag(diag) {
  const d = diag || {};
  const parts = [
    'result=' + (d.result || '?'),
    'raw=text:' + (d.text || 0) + ',attrs:' + (d.attrs || 0) + ',len:' + (d.rawLength || 0),
    'words=' + (d.words || 0),
    'skipped=notTranslatable:' + (d.skippedNotTranslatable || 0) + ',covered:' + (d.skippedCovered || 0) + ',listed:' + (d.skippedAlreadyListed || 0) + ',pending:' + (d.pendingUntranslated || 0),
    'wasOn=' + (d.wasOn ? 'yes' : 'no'),
    'textLen=' + (d.textLen ?? '?'),
    'originals=' + (d.hasOriginals ? 'yes' : 'no'),
    'extractMs=' + (d.extractMs ?? '?'),
    'captureMs=' + (d.captureMs ?? '?'),
  ];
  if (d.offError) parts.push('offError=' + clip(d.offError, 80));
  if (d.onError) parts.push('onError=' + clip(d.onError, 80));
  if (d.extractError) parts.push('extractError=' + clip(d.extractError, 80));
  if (d.statsError) parts.push('statsError=' + clip(d.statsError, 80));
  if (d.error) parts.push('error=' + clip(d.error, 80));
  // Why Latin-looking strings were not captured (first few samples only).
  if (d.dom && (d.dom.iframes || d.dom.shadowRoots || d.dom.canvases)) {
    parts.push('dom=iframes:' + (d.dom.iframes || 0) + ',blocked:' + (d.dom.iframesBlocked || 0) + ',shadow:' + (d.dom.shadowRoots || 0) + ',canvas:' + (d.dom.canvases || 0));
  }
  if (d.rejected && d.rejected.samples && d.rejected.samples.length) {
    parts.push('rejected=' + d.rejected.samples.map((s) => clip(s, 44)).join('; '));
  }
  return parts.join(' ');
}

function autoDiagRecord(session, diag, extra) {
  const d = diag || {};
  return Object.assign({
    port: session?.port || 0,
    bundleId: session?.bundle?.bundleId || session?.extId || '',
    epoch: autoEpochOf(session),
    result: d.result || '?',
    added: d.added || 0,
    text: d.text || 0,
    attrs: d.attrs || 0,
    words: d.words || 0,
    skippedNotTranslatable: d.skippedNotTranslatable || 0,
    skippedCovered: d.skippedCovered || 0,
    skippedAlreadyListed: d.skippedAlreadyListed || 0,
    wasOn: !!d.wasOn,
    extractMs: d.extractMs ?? null,
    captureMs: d.captureMs ?? null,
  }, extra || {});
}

// 'captured' means words were added; a 0-word run stays distinct from a failed
// or skipped one, which is the whole point of the trace.
function captureOutcome(diag, added) {
  const result = diag?.result;
  if (result === 'ok') return added ? 'captured' : 'captured-none';
  return result || 'unknown';
}

function recordSessionAuto(session, diag, extra) {
  const record = recordAutoCapture(autoDiagRecord(session, diag, extra));
  if (session) session.lastAutoRecord = record;
  return record;
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
    const diag = {};
    const added = mergeWordsIntoDict(key, JSON.parse(raw), diag);
    if (added || (diag.pendingUntranslated || 0) > 0) queueAutoTranslate(key, added || diag.pendingUntranslated || 0);
    return added;
  } catch (err) {
    vlog('collect failed', port, err.message);
    return 0;
  } finally {
    if (client) try { client.close(); } catch {}
  }
}

async function collectAll(live) {
  let added = 0;
  autoLog(null, 'manual-start', `panels=${live.length}`);
  for (const session of sessions.values()) {
    if (session.autoCaptureTimer) {
      clearTimeout(session.autoCaptureTimer);
      autoLog(session, 'timer-cancelled', 'reason=manual-capture');
    }
    session.autoCaptureTimer = null;
    session.lastAutoCaptureAt = Date.now();
  }
  for (const item of live) {
    const session = sessions.get(item.port);
    if (session) {
      added += await collectSession(session);
      // A manual capture covers everything on screen, so settle any pending hint.
      session.pendingEpoch = 0;
      session.pendingKind = '';
      session.autoAttempts = 0;
      session.nextAutoAttemptAt = 0;
      session.lastActivitySeen = Math.max(Number(session.lastActivitySeen) || 0, autoEpochOf(session));
      session.lastCapturedTextLen = Number(session.stats?.textLen) || 0;
      session.noSourceTextLen = null;   // a manual capture re-checks the panel
      session.verifyAt = 0;
    } else {
      added += await collectPort(item.port, item.page);
    }
  }
  lastCollect = { token: lastCollectToken, at: new Date().toISOString(), added };
  log(`[collect] all panels: +${added} words`);
  autoLog(null, 'manual-done', `added=${added}`);
  return added;
}

function scheduleAutoCapture(session, reason) {
  // Returns 'scheduled' or a 'skip:<reason>' code; the caller logs the code so a
  // consumed activity epoch without a capture is visible in the trace.
  if (!control.autoCapture || translationRunning || !session || session.translationDisabled) {
    const skip = !control.autoCapture ? 'auto-off'
      : translationRunning ? 'translation-running'
      : !session ? 'no-session' : 'translation-disabled';
    autoLog(session, 'skip', `reason=${skip} trigger=${reason} epoch=${autoEpochOf(session)}`);
    recordSessionAuto(session, null, { kind: reason, result: 'skipped', skipReason: skip });
    return 'skip:' + skip;
  }
  if (session.captureBusy) {
    autoLog(session, 'skip', `reason=capture-busy trigger=${reason} epoch=${autoEpochOf(session)}`);
    recordSessionAuto(session, null, { kind: reason, result: 'skipped', skipReason: 'capture-busy' });
    return 'skip:capture-busy';
  }
  if (session.autoCaptureTimer) clearTimeout(session.autoCaptureTimer);
  const since = Date.now() - (session.lastAutoCaptureAt || 0);
  const minInterval = captureIntervalMs(session);
  const delay = Math.max(AUTO_CAPTURE_DEBOUNCE_MS, minInterval - since);
  autoLog(session, 'schedule', `delay=${delay} min=${minInterval} trigger=${reason} epoch=${autoEpochOf(session)} seen=${Number(session.lastActivitySeen) || 0}${isSelectedSession(session) ? ' selected=yes' : ''}${session.stats?.hidden ? ' hidden=yes' : ''}`);
  session.autoCaptureTimer = setTimeout(async () => {
    session.autoCaptureTimer = null;
    // Whole callback is guarded: an unexpected throw here would otherwise be an
    // unhandled rejection and kill this agent silently (its stdio is ignored).
    try {
      const epochAtStart = Math.max(Number(session.pendingEpoch) || 0, autoEpochOf(session));
      // A failed or deferred attempt must not consume the activity, otherwise
      // the page switch is forgotten and the panel stays untranslated.
      const settle = (upto) => {
        session.lastActivitySeen = Math.max(Number(session.lastActivitySeen) || 0, Number(upto) || 0);
        const current = autoEpochOf(session);
        if (current > session.lastActivitySeen) {
          session.pendingEpoch = current;
          session.pendingKind = session.stats?.activityKind || 'activity';
        } else {
          session.pendingEpoch = 0;
          session.pendingKind = '';
        }
        session.autoAttempts = 0;
        session.nextAutoAttemptAt = 0;
      };
      const timerSkip = (code, extra = '', mode = 'transient') => {
        autoLog(session, 'timer-skip', `reason=${code}${extra ? ' ' + extra : ''} epoch=${autoEpochOf(session)} pending=${session.pendingEpoch || 0} mode=${mode}`);
        recordSessionAuto(session, null, { kind: reason, result: 'timer-skip', skipReason: code });
        if (mode === 'consume') settle(epochAtStart);
        else if (mode === 'drop') { session.pendingEpoch = 0; session.pendingKind = ''; session.autoAttempts = 0; }
        else session.nextAutoAttemptAt = Date.now() + AUTO_RETRY_BASE_MS;
        writeState(panelState(lastLive));
      };
      const captureFailed = (err) => {
        session.autoAttempts = (Number(session.autoAttempts) || 0) + 1;
        if (session.autoAttempts > AUTO_MAX_ATTEMPTS) {
          autoLog(session, 'capture-giveup', `attempts=${session.autoAttempts} epoch=${epochAtStart} note=safety-net-covers`);
          settle(epochAtStart);
        } else {
          session.nextAutoAttemptAt = Date.now() + AUTO_RETRY_BASE_MS * session.autoAttempts;
          autoLog(session, 'capture-retry', `attempts=${session.autoAttempts} in-ms=${AUTO_RETRY_BASE_MS * session.autoAttempts} err="${clip(err.message, 100)}"`);
        }
      };
      if (!control.autoCapture) { timerSkip('auto-off', '', 'consume'); return; }
      if (session.translationDisabled) { timerSkip('translation-disabled', '', 'consume'); return; }
      if (translationRunning) { timerSkip('translation-running', 'retry-in-ms=' + AUTO_RETRY_BASE_MS); return; }
      if (session.captureBusy) { timerSkip('capture-busy', 'retry-in-ms=' + AUTO_RETRY_BASE_MS); return; }
      if (!sessions.has(session.port) || session.client.ws.readyState !== 1) {
        timerSkip('panel-gone', '', 'drop');
        return;
      }
      const sinceFire = Date.now() - (session.lastAutoCaptureAt || 0);
      const fireInterval = captureIntervalMs(session);
      if (sinceFire < fireInterval) { timerSkip('min-interval', `since=${sinceFire} min=${fireInterval}`); return; }
      const key = pluginKey(session.bundle, session.extId);
      const diag = {};
      autoLog(session, 'capture-start', `epoch=${epochAtStart} trigger=${reason} delay=${delay} viewport=${control.captureViewportOnly ? 'on' : 'off'}${isSelectedSession(session) ? ' selected=yes' : ''}`);
      let added = 0;
      try {
        added = await collectSession(session, diag);
      } catch (err) {
        vlog('auto collect failed', err.message);
        autoLog(session, 'capture-error', `err=${clip(err.message, 120)} ${describeDiag(diag)}`);
        recordSessionAuto(session, diag, { kind: reason, result: 'error', error: err.message });
        captureFailed(err);
        writeState(panelState(lastLive));
        return;
      }
      if (diag.result === 'extract-null' || diag.result === 'parse-error') {
        // Runtime was missing or the extraction round-trip broke: retry.
        autoLog(session, 'capture-failed', `outcome=${diag.result} ${describeDiag(diag)}`);
        recordSessionAuto(session, diag, { kind: reason, result: diag.result });
        captureFailed(new Error(diag.result));
        writeState(panelState(lastLive));
        return;
      }
      const outcome = captureOutcome(diag, added);
      session.lastAutoCaptureAt = Date.now();
      autoLog(session, 'capture-done', `added=${added} outcome=${outcome} ${describeDiag(diag)}`);
      recordSessionAuto(session, diag, { kind: reason, result: outcome, added });
      settle(epochAtStart);
      if (typeof diag.textLen === 'number') session.lastCapturedTextLen = diag.textLen;
      else session.lastCapturedTextLen = Number(session.stats?.textLen) || 0;
      if (typeof diag.mutations === 'number') session.lastCapturedMutations = diag.mutations;
      else session.lastCapturedMutations = Number(session.stats?.mutations) || 0;
      // A panel with no translatable source at all (e.g. a natively Chinese
      // plugin) will keep producing empty captures; remember its content length
      // and skip further captures until the content actually changes.
      if (!added && (diag.text || 0) === 0 && (diag.attrs || 0) === 0) {
        session.noSourceTextLen = session.lastCapturedTextLen;
        autoLog(session, 'no-source', `textLen=${session.lastCapturedTextLen} note=skip-captures-until-content-changes`);
      } else if (added || (diag.text || 0) > 0 || (diag.attrs || 0) > 0) {
        session.noSourceTextLen = null;
      }
      if (added) {
        session.verifyAt = 0;
        session.verifyTries = 0;
      } else if ((diag.text || 0) > 0 || (diag.attrs || 0) > 0) {
        // Words were on screen but nothing was new: the page may still be
        // rendering the next card, so look again shortly (verify capture).
        session.verifyAt = Date.now() + AUTO_VERIFY_MS;
        session.verifyTries = 0;
      } else {
        session.verifyAt = 0;
        session.verifyTries = 0;
      }
      if (added) {
        lastCollect = {
          token: lastCollectToken,
          at: new Date().toISOString(),
          added,
          auto: true,
          bundleId: session.bundle?.bundleId || session.extId || '',
        };
        log(`[collect] auto ${key} +${added} (${reason})`);
      } else {
        vlog(`[collect] auto ${key}: no new words (${reason})`);
      }
      // Write after recording so a 0-word result and a captured result both land
      // in the same tick that produced them.
      writeState(panelState(lastLive));
    } catch (err) {
      autoLog(session, 'timer-error', `err=${clip(err.message, 120)}`);
      try {
        recordSessionAuto(session, null, { kind: reason, result: 'error', error: err.message });
        writeState(panelState(lastLive));
      } catch {}
    }
  }, delay);
  return 'scheduled';
}

/**
 * The runtime pushes activity through the CDP binding installed in attach(), so
 * a hint is handled within milliseconds instead of waiting for the next 1 s poll.
 * Polling stays as the fallback (old runtime, binding rejected by the host).
 */
function activityPush(session) {
  if (!session || !control.autoCapture || session.translationDisabled) return;
  session.lastPushAt = Date.now();
  if (session.activityPushBusy) { session.activityPushPending = true; return; }
  session.activityPushBusy = true;
  pollSessionActivity(session, { force: true })
    .catch(() => {})
    .finally(() => {
      session.activityPushBusy = false;
      if (session.activityPushPending) {
        session.activityPushPending = false;
        activityPush(session);
      }
    });
}

async function pollSessionActivity(session, { force = false } = {}) {
  if (!session || session.client.ws.readyState !== 1) {
    autoLogThrottled(session, 'poll', `ws-not-open readyState=${session ? session.client.ws.readyState : '?'}`);
    return;
  }
  if (!control.autoCapture) {
    // Once per off-period, not every 30 s: the user toggles this often.
    autoLogOnce(session, 'poll-auto-off', 'idle reason=auto-off');
    return;
  }
  const now = Date.now();
  if (!force && now - (session.lastActivityPollAt || 0) < 1000) return;
  session.lastActivityPollAt = now;
  let stats = null;
  try { stats = await readStats(session.client); } catch (err) {
    autoLogThrottled(session, 'poll', `stats-error ${clip(err.message, 80)}`);
    return;
  }
  if (!stats) {
    // No runtime object: injection lost (reload, old runtime, closed port).
    autoLogThrottled(session, 'poll', 'stats=null runtime-missing');
    return;
  }
  session.stats = stats;
  // An old runtime has no activityEpoch at all; that alone disables every
  // auto-capture trigger, so it must be explicit in the trace.
  if (!Object.prototype.hasOwnProperty.call(stats, 'activityEpoch')) {
    autoLogOnce(session, 'runtime-no-epoch', `runtime=${session.runtimeVersion || session.config?.version || '?'} (re-inject or restart Adobe)`);
  }
  const epoch = Number(stats.activityEpoch) || 0;
  const seen = Number(session.lastActivitySeen) || 0;
  if (epoch < seen) {
    // The runtime was replaced and its activity counter started over.
    autoLog(session, 'epoch-reset', `epoch=${epoch} seen=${seen}`);
    session.lastActivitySeen = 0;
    session.pendingEpoch = 0;
    session.pendingKind = '';
  }
  if (epoch > seen) {
    // Record the hint but do NOT consume it here: only a finished capture may
    // advance lastActivitySeen, so a skipped or failed attempt is retried.
    // Log once per new hint — polls while a capture is pending would otherwise
    // print the same activity line every second.
    if (epoch > (Number(session.pendingEpoch) || 0)) {
      autoLog(session, 'activity', `epoch=${epoch} seen=${seen} pending=${Number(session.pendingEpoch) || 0} kind=${stats.activityKind || '?'} hidden=${!!stats.hidden} focused=${!!stats.focused} changed=${stats.changed} textLen=${stats.textLen} push=${session.lastPushAt ? (Date.now() - session.lastPushAt) + 'ms' : '-'} href="${clip(stats.href, 120)}"`);
      session.pendingEpoch = epoch;
      session.pendingKind = stats.activityKind || 'activity';
    }
  }
  maybeSchedulePendingCapture(session);
  maybeVerifyCapture(session);
  maybeSafetyCapture(session, stats);
  if (epoch <= seen && !session.pendingEpoch) {
    autoLogThrottled(session, 'idle', `epoch=${epoch} seen=${seen} kind=${stats.activityKind || '-'} hidden=${!!stats.hidden} focused=${!!stats.focused} changed=${stats.changed} textLen=${stats.textLen}`);
  }
}

/** Arm the debounced capture when a pending activity exists and nothing blocks it. */
function maybeSchedulePendingCapture(session) {
  const pending = Number(session.pendingEpoch) || 0;
  if (!pending) return;
  if (pending <= (Number(session.lastActivitySeen) || 0)) { session.pendingEpoch = 0; return; }
  if (session.autoCaptureTimer) return;                 // already armed; don't push it back
  if (session.captureBusy) return;                      // next poll will retry
  if (!control.autoCapture || translationRunning || session.translationDisabled) return;
  if (Date.now() < (session.nextAutoAttemptAt || 0)) return;
  // "Only capture the selected plugin": other panels are skipped, but their
  // activity is consumed so it does not pile up.
  if (!captureTargetOk(session)) {
    autoLogThrottled(session, 'target-skip', `pending=${pending} selected=${control.selectedBundle || '-'}`);
    session.lastActivitySeen = Math.max(Number(session.lastActivitySeen) || 0, pending);
    session.pendingEpoch = 0;
    session.pendingKind = '';
    return;
  }
  // Natively Chinese panel: its last capture found no translatable source and its
  // text length has not changed since, so there is nothing to capture.
  if (session.noSourceTextLen != null && Number(session.stats?.textLen) === session.noSourceTextLen) {
    autoLogThrottled(session, 'no-source-skip', `textLen=${session.noSourceTextLen} pending=${pending}`);
    session.lastActivitySeen = Math.max(Number(session.lastActivitySeen) || 0, pending);
    session.pendingEpoch = 0;
    session.pendingKind = '';
    return;
  }
  scheduleAutoCapture(session, session.pendingKind || 'activity');
}

/**
 * Verify capture: a 0-word capture can mean the page was still rendering. When
 * the panel's content length changed since that capture, capture once more
 * instead of waiting for the 9 s safety net.
 */
function maybeVerifyCapture(session) {
  if (!session.verifyAt) return;
  if (Date.now() < session.verifyAt) return;
  session.verifyAt = 0;
  if (!control.autoCapture || translationRunning || session.translationDisabled) return;
  if (!captureTargetOk(session)) return;
  if (session.autoCaptureTimer || session.captureBusy) return;
  if (session.noSourceTextLen != null && Number(session.stats?.textLen) === session.noSourceTextLen) return;
  const textLen = Number(session.stats?.textLen) || 0;
  const mutations = Number(session.stats?.mutations) || 0;
  const lenChanged = textLen !== (Number(session.lastCapturedTextLen) || 0);
  // Same-length text swaps ("CAMCORDER 1" -> "CAMCORDER 2") are invisible to a
  // length check; the runtime's mutation counter catches them.
  const mutsChanged = mutations !== (Number(session.lastCapturedMutations) || 0);
  if (lenChanged || mutsChanged) {
    autoLog(session, 'verify-trigger', `textLen=${textLen} last=${session.lastCapturedTextLen} mutations=${mutations} lastMut=${session.lastCapturedMutations ?? '?'} try=${(Number(session.verifyTries) || 0) + 1}`);
    scheduleAutoCapture(session, 'verify');
    return;
  }
  // Content unchanged: panels that update after a slow ExtendScript round trip
  // may need another look (1.5 s each, up to AUTO_MAX_VERIFIES).
  session.verifyTries = (Number(session.verifyTries) || 0) + 1;
  if (session.verifyTries < AUTO_MAX_VERIFIES) {
    session.verifyAt = Date.now() + AUTO_VERIFY_MS;
    autoLogThrottled(session, 'verify-wait', `try=${session.verifyTries} textLen=${textLen} mutations=${mutations}`);
  } else {
    autoLog(session, 'verify-giveup', `tries=${session.verifyTries} textLen=${textLen} mutations=${mutations} note=safety-net-covers`);
    session.verifyTries = 0;
  }
}

/**
 * Safety net: a page can switch with no focus/click/route hint at all (or the
 * capture lands before the new DOM exists).
 * - visible + focused panel: checked every SAFETY_CAPTURE_MS;
 * - hidden panel: pre-captured every SAFETY_HIDDEN_CAPTURE_MS when its content
 *   changed, so its words/translations are ready when the user shows it again.
 */
function maybeSafetyCapture(session, stats) {
  if (!control.autoCapture || translationRunning || session.translationDisabled) return;
  if (!captureTargetOk(session)) return;
  const hidden = !!stats.hidden;
  if (!hidden && !stats.focused) return;
  if (session.autoCaptureTimer || session.captureBusy) return;
  if (Number(session.pendingEpoch) > (Number(session.lastActivitySeen) || 0)) return;
  const now = Date.now();
  const interval = hidden ? SAFETY_HIDDEN_CAPTURE_MS : SAFETY_CAPTURE_MS;
  if (now - (session.lastSafetyAt || 0) < interval) return;
  if (now - (session.lastAutoCaptureAt || 0) < SAFETY_MIN_GAP_MS) return;
  const textLen = Number(stats.textLen) || 0;
  const lastLen = Number(session.lastCapturedTextLen);
  if (Number.isFinite(lastLen) && textLen === lastLen) return;   // nothing changed
  session.lastSafetyAt = now;
  autoLog(session, 'safety-trigger', `textLen=${textLen} last=${Number.isFinite(lastLen) ? lastLen : '?'} epoch=${autoEpochOf(session)} changed=${stats.changed}${hidden ? ' hidden=yes' : ''}`);
  scheduleAutoCapture(session, 'safety');
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
    session.lastActivitySeen = Number(session.stats?.activityEpoch) || 0;
    session.pendingEpoch = 0;
    session.pendingKind = '';
    session.autoAttempts = 0;
    session.nextAutoAttemptAt = 0;
    session.lastSafetyAt = 0;
    session.autoCaptureTimer = null;
    sessions.set(live.port, session);

    session.client.on((msg) => {
      if (msg.method === 'Runtime.bindingCalled' && msg.params && msg.params.name === '__cepZhActivity') {
        activityPush(session);
        return;
      }
      if (msg.method === 'Page.frameNavigated') {
        setTimeout(async () => {
          if (session.translationDisabled) return;
          try { await evaluateOn(session, session.source); } catch {}
          // Panels often rebuild their UI on reload; capture any newly appeared words.
          setTimeout(() => {
            if (!control.autoCapture || session.translationDisabled) {
              autoLog(session, 'reload-collect-skip', `reason=${!control.autoCapture ? 'auto-off' : 'translation-disabled'}`);
              return;
            }
            const diag = {};
            autoLog(session, 'reload-collect-start');
            collectSession(session, diag).then((added) => {
              session.lastAutoCaptureAt = Date.now();
              const outcome = captureOutcome(diag, added);
              autoLog(session, 'reload-collect-done', `added=${added} outcome=${outcome} ${describeDiag(diag)}`);
              recordSessionAuto(session, diag, { kind: 'reload', result: outcome, added });
              if (added) {
                lastCollect = {
                  token: lastCollectToken,
                  at: new Date().toISOString(),
                  added,
                  auto: true,
                  bundleId: session.bundle?.bundleId || session.extId || '',
                };
              }
              writeState(panelState(lastLive));
            }).catch((err) => {
              vlog('reload collect failed', err.message);
              autoLog(session, 'reload-collect-error', `err=${clip(err.message, 120)} ${describeDiag(diag)}`);
              recordSessionAuto(session, diag, { kind: 'reload', result: 'error', error: err.message });
              writeState(panelState(lastLive));
            });
          }, 900);
        }, 300);
      }
    });

    const stats = session.stats || {};
    // Read the live runtime version so an old injected runtime is unmistakable.
    try {
      session.runtimeVersion = String(await evaluate(session.client, 'window.__CEP_ZH__ && window.__CEP_ZH__.version || ""') || '');
    } catch { session.runtimeVersion = ''; }
    log(`[inject] :${live.port}  ${bundleId}  dict=${cfg.dictionaryFiles.map((f) => path.basename(f)).join('+') || 'global'}  changed=${stats.changed ?? '?'}`);
    const hasEpochField = Object.prototype.hasOwnProperty.call(stats, 'activityEpoch');
    autoLog(session, 'inject', `dict=${cfg.dictionaryFiles.map((f) => path.basename(f)).join('+') || 'global'} changed=${stats.changed ?? '?'} runtime=${session.runtimeVersion || '?'} epochField=${hasEpochField ? 'yes' : 'no'} epoch=${Number(stats.activityEpoch) || 0} enabled=${stats.enabled}`);

    const key = `${bundleId}|${session.url}`;
    if (control.autoCapture && bundleId && !bundleId.startsWith('cep.zh.') && !autoCollected.has(key)) {
      autoCollected.add(key);
      const diag = {};
      autoLog(session, 'initial-collect-start');
      let initialAdded = 0;
      try { initialAdded = await collectSession(session, diag); } catch (err) { vlog('auto collect failed', err.message); }
      session.lastAutoCaptureAt = Date.now();
      const outcome = captureOutcome(diag, initialAdded);
      autoLog(session, 'initial-collect-done', `added=${initialAdded} outcome=${outcome} ${describeDiag(diag)}`);
      recordSessionAuto(session, diag, { kind: 'initial', result: outcome, added: initialAdded });
      if (typeof diag.textLen === 'number') session.lastCapturedTextLen = diag.textLen;
      if (typeof diag.mutations === 'number') session.lastCapturedMutations = diag.mutations;
      if (!initialAdded && (diag.text || 0) === 0 && (diag.attrs || 0) === 0) session.noSourceTextLen = session.lastCapturedTextLen;
      else session.noSourceTextLen = null;
      if (!initialAdded && ((diag.text || 0) > 0 || (diag.attrs || 0) > 0)) {
        session.verifyAt = Date.now() + AUTO_VERIFY_MS;
        session.verifyTries = 0;
      }
    }
    // Consume activity caused by the initial injection/focus. Later route or
    // focus changes will still produce a new activity epoch.
    try {
      const fresh = await readStats(session.client);
      if (fresh) {
        session.stats = fresh;
        session.lastActivitySeen = Number(fresh.activityEpoch) || 0;
        session.pendingEpoch = 0;
        session.pendingKind = '';
        session.lastCapturedTextLen = Number(fresh.textLen) || 0;
        session.lastActivityPollAt = Date.now();
      }
    } catch {}
    if (!session.lastAutoCaptureAt) session.lastAutoCaptureAt = Date.now();
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
      name: manifestDisplayName(bundle) || '',
      extId,
      disabled,
      injected: !!session && !session.translationDisabled,
      stats: session?.stats || null,
      // Per-panel auto-capture view so state.json alone shows whether activity is
      // being seen and which capture outcome happened last for that panel.
      auto: session ? {
        epoch: autoEpochOf(session),
        seen: Number(session.lastActivitySeen) || 0,
        pending: Number(session.pendingEpoch) || 0,
        attempts: Number(session.autoAttempts) || 0,
        lastAttemptAt: session.lastAutoCaptureAt ? new Date(session.lastAutoCaptureAt).toISOString() : '',
        lastResult: session.lastAutoRecord?.result || '',
        lastAdded: session.lastAutoRecord?.added ?? null,
        lastSkipReason: session.lastAutoRecord?.skipReason || '',
        captureBusy: !!session.captureBusy,
        timerPending: !!session.autoCaptureTimer,
        safetyAt: session.lastSafetyAt ? new Date(session.lastSafetyAt).toISOString() : '',
        selected: isSelectedSession(session),
        intervalMs: captureIntervalMs(session),
        noSource: session.noSourceTextLen != null,
        translationDisabled: !!session.translationDisabled,
      } : null,
    };
  }).filter((p) => !String(p.bundleId).startsWith('cep.zh.'));
}

let lastProbeAt = 0;
const probedListening = new Map(); // port -> probed while listening (reset when it closes)

/**
 * Fast panel discovery: netstat lists loopback listeners, and only the ones that
 * were not probed before are asked for /json. A .debug port that is not listening
 * costs nothing, so a panel that just opened is found in < PROBE_TICK_MS.
 */
async function probeNewListeningPorts(live) {
  let listeners;
  try { listeners = listLoopbackListeningPorts(); } catch { return false; }
  const current = new Set(listeners.map((l) => l.port));
  for (const port of [...probedListening.keys()]) {
    if (!current.has(port)) probedListening.delete(port);
  }
  const livePorts = new Set(live.map((l) => l.port));
  let found = false;
  for (const port of current) {
    if (livePorts.has(port) || sessions.has(port) || probedListening.has(port)) continue;
    probedListening.set(port, Date.now());
    let targets;
    try { targets = await listTargets(port, PROBE_TIMEOUT_MS); } catch { continue; }
    const page = targets.find((t) => t.type === 'page');
    if (!page) continue;
    // Only inject into pages that belong to a known CEP extension: a random
    // DevTools port from another program must not be hijacked.
    const resolved = resolveLiveTarget(scan, portIndex, { port, page });
    if (!resolved || (!resolved.bundle && !resolved.extId)) continue;
    live.push({ port, pid: 0, page, targets, probed: true });
    livePorts.add(port);
    found = true;
    autoLog(null, 'probe-found', `port=${port} target="${clip(page.title, 50)}" url="${clip(page.url, 90)}"`);
  }
  return found;
}

async function tick() {
  await syncControl();

  // Full discovery (tasklist+netstat) runs on a slow cadence; the fast netstat
  // probe below notices new panels in half a second.
  const nowTick = Date.now();
  const wantDiscover = !lastDiscoverAt ||
    nowTick - lastDiscoverAt >= DISCOVER_INTERVAL_MS ||
    (control.collectToken && control.collectToken !== lastCollectToken);
  if (wantDiscover) {
    const fresh = await discoverLivePanels();
    const extras = lastLive.filter((l) => l.probed && sessions.has(l.port) && !fresh.some((f) => f.port === l.port));
    lastLive = [...fresh, ...extras];
    lastDiscoverAt = nowTick;
  }
  const live = lastLive;
  if (nowTick - lastProbeAt >= PROBE_TICK_MS) {
    lastProbeAt = nowTick;
    try { await probeNewListeningPorts(live); } catch (err) { vlog('probe failed', err.message); }
  }
  const livePorts = new Set(live.map((l) => l.port));

  for (const [port, session] of sessions) {
    if (!livePorts.has(port) || session.client.ws.readyState !== 1) {
      try { session.client.close(); } catch {}
      sessions.delete(port);
      probedListening.delete(port);
      const stale = live.findIndex((l) => l.port === port && l.probed);
      if (stale >= 0) live.splice(stale, 1);
      vlog(`[drop] :${port}`);
    }
  }

  const newItems = live.filter((item) => !sessions.has(item.port));
  for (let i = 0; i < newItems.length; i += INJECT_CONCURRENCY) {
    const batch = newItems.slice(i, i + INJECT_CONCURRENCY);
    await Promise.all(batch.map(async (item) => {
      const session = await injectPanel(item).catch(() => null);
      if (!session && item.probed) {
        const idx = live.indexOf(item);
        if (idx >= 0) live.splice(idx, 1);
        probedListening.delete(item.port);
      }
    }));
  }

  for (const session of sessions.values()) {
    await pollSessionActivity(session);
  }

  if (control.collectToken && control.collectToken !== lastCollectToken) {
    lastCollectToken = control.collectToken;
    // A token left over from a previous run is consumed on the first tick and
    // overwrites lastCollect with auto:false — worth telling apart from a click.
    autoLog(null, 'manual-token', `token=${clip(control.collectToken, 40)} phase=${firstTick ? 'boot-consumed-leftover-token' : 'user-request'} panels=${live.length}`);
    await collectAll(live);
  }
  firstTick = false;

  autoRepairWritable();
  writeState(panelState(live));
  return live.length;
}

/**
 * Per-dictionary signatures (lower-cased keys) so a change in one plugin's file
 * only re-injects that plugin's panel. `__global__` means "every panel", because
 * the global dictionary is a fallback for all of them.
 */
function dictionarySignatureByKey(d) {
  const out = new Map();
  const globalEntries = [];
  for (const [key, value] of Object.entries(d.global?.strings || {})) {
    if (value) globalEntries.push([key, value]);
  }
  if (d.global?.patterns?.length) globalEntries.push(['@patterns', d.global.patterns]);
  out.set('__global__', JSON.stringify(globalEntries));
  const seen = new Set();
  for (const [key, record] of d.byKey.entries()) {
    if (!record || seen.has(record)) continue;
    seen.add(record);
    const entries = [];
    for (const [source, value] of Object.entries(record.strings || {})) {
      if (value) entries.push([source, value]);
    }
    if (record.patterns?.length) entries.push(['@patterns', record.patterns]);
    out.set(String(key).toLowerCase(), JSON.stringify(entries));
  }
  return out;
}

async function reloadDictionaries() {
  // A translation task writes dictionaries itself and reloads when it finishes;
  // reinjecting from the file watcher mid-task would only flicker the panels.
  if (translationRunning) {
    autoLog(null, 'dict-reload', 'skipped=translation-running');
    return;
  }
  const before = dictionarySignatureByKey(dicts);
  const next = loadDictionaries();
  const after = dictionarySignatureByKey(next);
  dicts = next;
  log(`[dict] reloaded (${dicts.byKey.size} keys)`);
  // A dictionary edit may have removed or re-added words, so give every echoed
  // word another chance the next time auto-translate runs.
  autoTranslateUnchanged.clear();
  const changedKeys = new Set();
  for (const [key, sig] of after) if (before.get(key) !== sig) changedKeys.add(key);
  for (const key of before.keys()) if (!after.has(key)) changedKeys.add(key);
  const changed = changedKeys.size > 0;
  autoLog(null, 'dict-reload', `keys=${dicts.byKey.size} changed=${changed ? 'yes' : 'no'}${changed ? ' which=' + [...changedKeys].slice(0, 8).join(',') : ''}`);
  if (!changed) {
    vlog('[dict] no translation changes; runtime reinjection skipped');
    return;
  }
  // The global dictionary is a fallback for every panel, so a global change still
  // re-injects all of them; a per-plugin change only touches that plugin.
  const reinjectAll = changedKeys.has('__global__');
  for (const session of sessions.values()) {
    if (session.translationDisabled) continue;
    if (!reinjectAll) {
      const sessionKeys = dictionaryKeysFor({ bundle: session.bundle, extId: session.extId })
        .map((k) => String(k).toLowerCase());
      if (!sessionKeys.some((k) => changedKeys.has(k))) continue;
    }
    try {
      await reinject(session, configFor(session.port, session.bundle, session.extId));
      log(`[inject] :${session.port} re-injected after dictionary change (changed=${session.stats?.changed ?? '?'})`);
      autoLog(session, 'reinject', `reason=dict-change changed=${session.stats?.changed ?? '?'} epoch=${autoEpochOf(session)}`);
      session.lastCapturedMutations = Number(session.stats?.mutations) || 0;
      session.verifyAt = 0;
      session.verifyTries = 0;
    } catch (err) {
      vlog('reinject failed', session.port, err.message);
      autoLog(session, 'reinject-error', `reason=dict-change err=${clip(err.message, 120)}`);
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
  autoLog(null, 'boot', `pid=${process.pid} interval=${args.interval} autoCapture=${control.autoCapture} autoTranslate=${control.autoTranslate} translationRunning=${translationRunning} pendingCollectToken=${control.collectToken ? 'yes' : 'no'} log=${AUTO_LOG_PATH}`);
  setAutoTranslateState({ status: 'idle', message: control.autoTranslate ? '已开启' : '未开启' });
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

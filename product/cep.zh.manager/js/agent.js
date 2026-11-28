/* CEP-ZH hidden agent bootstrap.
 *
 * Runs in CEP's Node-enabled hidden panel. It does not implement injection by
 * itself; it starts the cep-zh Agent (external Node prototype) with the host
 * PID and writes a status file the Manager can read. If the Agent exits or
 * stops writing its heartbeat it is restarted automatically; the Manager can
 * also ask for a restart through agent/restart.token.
 *
 * Config: %APPDATA%\CEP-ZH\config.json
 *   { "nodePath": "C:\\...\\node.exe", "agentScript": "F:\\...\\tools\\cep-zh\\agent.mjs",
 *     "extraArgs": ["--catalog"] }
 */
(function () {
  'use strict';
  var fs, cp;
  try {
    fs = require('fs');
    cp = require('child_process');
  } catch (e) {
    return;
  }

  var host = window.__adobe_cep__;
  if (!host) return;
  var userData = decodeURI(host.getSystemPath('userData'))
    .replace(/^file:\/\/\//i, '').replace(/\//g, '\\');
  var base = userData.replace(/\\+$/, '') + '\\CEP-ZH';
  var dir = base + '\\agent';
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  var hostPid = (typeof process !== 'undefined' && process.ppid) ? process.ppid : 0;
  var statusPath = dir + '\\status-' + (hostPid || 'unknown') + '.json';
  var logPath = dir + '\\agent.log';
  var statePath = base + '\\state.json';
  var restartTokenPath = dir + '\\restart.token';

  function log(msg) {
    try { fs.appendFileSync(logPath, new Date().toISOString() + ' ' + msg + '\r\n'); } catch (e) {}
  }
  function writeStatus(obj) {
    obj.updatedAt = new Date().toISOString();
    try { fs.writeFileSync(statusPath, JSON.stringify(obj, null, 2)); } catch (e) {}
  }

  var cfg = {};
  try {
    var raw = fs.readFileSync(base + '\\config.json', 'utf8');
    cfg = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch (e) {
    log('config read failed: ' + e);
  }
  var script = cfg.agentScript || '';
  var node = cfg.nodePath || 'node';

  if (!script || !fs.existsSync(script)) {
    writeStatus({ state: 'unconfigured', hostPid: hostPid, config: base + '\\config.json',
      hint: 'set nodePath/agentScript in config.json' });
    log('unconfigured: ' + script);
    return;
  }

  var args = [script].concat(cfg.extraArgs || []);
  if (hostPid) args.push('--host-pid', String(hostPid));

  var child = null;
  var restarts = [];
  var restartTimer = null;
  var gaveUp = false;
  var startedAt = Date.now();
  var WATCHDOG_STALE_MS = 90000;
  var RESTART_WINDOW_MS = 10 * 60 * 1000;
  var RESTART_DELAYS = [1000, 2000, 5000, 10000, 20000];

  function baseStatus() {
    return {
      hostPid: hostPid, node: node, script: script,
      agentPid: child ? child.pid : 0,
      startedAt: new Date(startedAt).toISOString(),
      restarts: restarts.length,
    };
  }

  function scheduleRestart(reason) {
    if (gaveUp) return;
    var now = Date.now();
    restarts = restarts.filter(function (t) { return now - t < RESTART_WINDOW_MS; });
    if (restarts.length >= 5) {
      gaveUp = true;
      writeStatus(Object.assign(baseStatus(), { state: 'gave-up', reason: reason }));
      log('restart limit reached, giving up');
      return;
    }
    restarts.push(now);
    var delay = RESTART_DELAYS[Math.min(restarts.length - 1, RESTART_DELAYS.length - 1)];
    writeStatus(Object.assign(baseStatus(), { state: 'restarting', reason: reason, delay: delay }));
    log('restart in ' + delay + 'ms (' + reason + ')');
    clearTimeout(restartTimer);
    restartTimer = setTimeout(function () { spawnAgent('restart'); }, delay);
  }

  function spawnAgent(reason) {
    restartTimer = null;
    if (child && child.exitCode === null) return;
    var spawned;
    try {
      spawned = cp.spawn(node, args, { windowsHide: true, stdio: 'ignore', detached: false });
    } catch (e) {
      writeStatus(Object.assign(baseStatus(), { state: 'spawn-failed', error: String(e) }));
      log('spawn failed: ' + e);
      scheduleRestart('spawn-failed');
      return;
    }
    child = spawned;
    startedAt = Date.now();
    writeStatus(Object.assign(baseStatus(), { state: 'running', reason: reason }));
    log('spawned child=' + child.pid + ' host=' + hostPid + ' node=' + node);
    child.on('exit', function (code, signal) {
      log('child exited code=' + code + ' signal=' + signal);
      scheduleRestart('exit');
    });
    child.on('error', function (err) {
      log('child error: ' + err);
      scheduleRestart('error');
    });
  }

  function forceRestart(reason) {
    log('restart requested (' + reason + ')');
    restarts = [];
    gaveUp = false;
    clearTimeout(restartTimer);
    restartTimer = null;
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (e) {}
      // The exit handler schedules the respawn.
    } else {
      spawnAgent(reason);
    }
  }

  spawnAgent('initial');

  setInterval(function () {
    // Manual restart token from the Manager.
    try {
      if (fs.existsSync(restartTokenPath)) {
        fs.unlinkSync(restartTokenPath);
        forceRestart('manual');
        return;
      }
    } catch (e) {}
    if (!child || child.exitCode !== null) return;
    // Watchdog: the Agent rewrites state.json every tick, so a stale file means
    // the process is hung even though it still exists.
    var stale = false;
    try {
      var st = fs.statSync(statePath);
      var mtime = st.mtimeMs || (st.mtime && st.mtime.getTime()) || 0;
      stale = mtime > 0 && Date.now() - mtime > WATCHDOG_STALE_MS;
    } catch (e) {
      stale = Date.now() - startedAt > WATCHDOG_STALE_MS;
    }
    if (stale) {
      log('watchdog: no heartbeat, killing child');
      writeStatus(Object.assign(baseStatus(), { state: 'hung' }));
      try { child.kill(); } catch (e) {}
      return;
    }
    writeStatus(Object.assign(baseStatus(), { state: 'running' }));
  }, 5000);

  window.addEventListener('beforeunload', function () {
    clearTimeout(restartTimer);
    try { if (child) child.kill(); } catch (e) {}
  });
})();

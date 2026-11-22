/* CEP-ZH hidden agent bootstrap.
 *
 * Runs in CEP's Node-enabled hidden panel. It does not implement injection by
 * itself; it starts the cep-zh Agent (external Node prototype) with the host
 * PID and writes a status file the Manager can read.
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
  var child;
  try {
    child = cp.spawn(node, args, { windowsHide: true, stdio: 'ignore', detached: false });
  } catch (e) {
    writeStatus({ state: 'spawn-failed', hostPid: hostPid, error: String(e), node: node, script: script });
    log('spawn failed: ' + e);
    return;
  }

  var state = {
    state: 'running', hostPid: hostPid, childPid: child.pid,
    node: node, script: script, startedAt: new Date().toISOString()
  };
  writeStatus(state);
  log('spawned child=' + child.pid + ' host=' + hostPid + ' node=' + node);

  child.on('exit', function (code, signal) {
    state.state = 'exited';
    state.exitCode = code;
    state.signal = signal;
    state.exitedAt = new Date().toISOString();
    writeStatus(state);
    log('child exited code=' + code + ' signal=' + signal);
  });
  child.on('error', function (err) {
    state.state = 'error';
    state.error = String(err);
    writeStatus(state);
    log('child error: ' + err);
  });

  setInterval(function () {
    if (state.state === 'running') writeStatus(state);
  }, 5000);

  window.addEventListener('beforeunload', function () {
    try { child.kill(); } catch (e) {}
  });
})();

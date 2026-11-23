/* CEP 汉化管理器 - modern editor prototype (no build step). */
(function () {
  'use strict';

  var host = window.__adobe_cep__;
  var FS = (window.cep && window.cep.fs) || null;

  function nativePath(p) {
    return decodeURI(p || '').replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '').replace(/\\/g, '/');
  }
  function appDataPath() {
    try { return nativePath(host.getSystemPath('userData')); } catch (e) { return ''; }
  }

  var APP = appDataPath();
  var BASE = APP.replace(/\/+$/, '') + '/CEP-ZH';
  var DICT = BASE + '/dict';
  var EXT = DICT + '/extensions';
  var CONTROL = BASE + '/control.json';
  var AGENT_STATE = BASE + '/state.json';
  var CONFIG = BASE + '/config.json';
  var GITHUB_URL = 'https://github.com/Three-LEI/CEP-ZH';
  var BILI_URL = 'https://space.bilibili.com/353544977';
  var APP_VERSION = '0.2.7';
  var RELEASES_URL = GITHUB_URL + '/releases/latest';
  var LATEST_RELEASE_API = 'https://api.github.com/repos/Three-LEI/CEP-ZH/releases/latest';
  var UPDATE_DISMISS_KEY = 'cepzh.update.dismissed';
  var UPDATE_CHECK_KEY = 'cepzh.update.checkedAt';
  var EXTENSION = '';
  try { EXTENSION = nativePath(host.getSystemPath('extension')); } catch (e) {}
  var BUNDLED = EXTENSION + '/dict';

  var S = {
    view: 'plugin',
    key: null,
    control: { enabled: true, disabledPlugins: [], collectToken: '' },
    agent: null,
    common: { strings: {}, patterns: [] },
    filter: 'all',
    search: '',
    pluginSearch: '',
    globalSearch: '',
    page: 1,
    pageSize: 50,
    globalFilter: 'all',
    globalPage: 1,
    lastDictJson: '',
    addKind: 'plugin',
    theme: 'dark',
    apiDirty: false,
    sig: '',
    exportSelected: null,
    exportLog: '尚未操作',
    importOverwrite: false,
    translationRunning: false,
    lastTranslationSeen: '',
    debugDismissed: '',
    debugSig: '',
    repairToken: '',
    repairToastToken: '',
    lastAutoSeen: '',
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function sanitizeKey(s) { return String(s || 'unknown').replace(/[^\w.-]+/g, '_'); }
  function isJunk(s) {
    if (!s) return true;
    if (/[{}]/.test(s)) return true;
    if (/(?:fill|stroke|font-size|font-family|background|opacity|color|margin|padding|display)\s*:/i.test(s)) return true;
    if (/^(?:https?|file):\/\//i.test(s)) return true;
    return false;
  }
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, ms || 1800);
  }

  function ensureDir(p) {
    if (!FS || !p) return false;
    var r = FS.makedir(p);
    return r.err === 0 || r.err === 10 || r.err === 12;
  }
  function readJson(p, fallback) {
    if (!FS) return fallback;
    var r = FS.readFile(p);
    if (r.err !== 0 || !r.data) return fallback;
    try { return JSON.parse(r.data); } catch (e) { return fallback; }
  }
  function writeJson(p, obj) {
    if (!FS) { toast('cep.fs 不可用'); return false; }
    ensureDir(p.substring(0, p.lastIndexOf('/')));
    var r = FS.writeFile(p, JSON.stringify(obj, null, 2));
    if (r.err !== 0) { toast('写入失败：' + p); return false; }
    return true;
  }
  function listDir(p) {
    if (!FS) return [];
    var r = FS.readdir(p);
    return r.err === 0 ? r.data : [];
  }

  function seedDefaults() {
    if (!FS) return;
    ensureDir(BASE); ensureDir(DICT); ensureDir(EXT);
    if (!readJson(DICT + '/global.json', null) && readJson(BUNDLED + '/global.json', null)) {
      var g = FS.readFile(BUNDLED + '/global.json');
      if (g.err === 0) FS.writeFile(DICT + '/global.json', g.data);
    }
    if (!listDir(EXT).length) {
      var files = listDir(BUNDLED + '/extensions');
      for (var i = 0; i < files.length; i++) {
        if (!/\.json$/i.test(files[i])) continue;
        var f = FS.readFile(BUNDLED + '/extensions/' + files[i]);
        if (f.err === 0) FS.writeFile(EXT + '/' + files[i], f.data);
      }
    }
  }

  function loadCommon() {
    var user = readJson(DICT + '/global.json', { strings: {} });
    var bundled = readJson(BUNDLED + '/global.json', { strings: {} });
    var strings = {};
    Object.assign(strings, bundled.strings || {});
    Object.keys(user.strings || {}).forEach(function (k) {
      var v = user.strings[k];
      if (v) strings[k] = v;
      else if (!(k in strings)) strings[k] = '';
    });
    S.common = { strings: strings, patterns: [].concat(bundled.patterns || [], user.patterns || []) };
  }

  function loadPlugin(key) {
    var user = readJson(EXT + '/' + key + '.json', { name: key, strings: {}, patterns: [] });
    var bundled = readJson(BUNDLED + '/extensions/' + key + '.json', { name: key, strings: {}, patterns: [] });
    if (!user.strings) user.strings = {};
    if (!bundled.strings) bundled.strings = {};
    return { key: key, name: user.name || bundled.name || key, user: user, bundled: bundled };
  }

  function pluginKeys() {
    var set = new Set();
    listDir(EXT).forEach(function (n) { if (/\.json$/i.test(n)) set.add(n.replace(/\.json$/i, '')); });
    listDir(BUNDLED + '/extensions').forEach(function (n) { if (/\.json$/i.test(n)) set.add(n.replace(/\.json$/i, '')); });
    if (S.agent && Array.isArray(S.agent.panels)) {
      S.agent.panels.forEach(function (p) {
        if (p.bundleId && !p.bundleId.startsWith('cep.zh.')) set.add(sanitizeKey(p.bundleId));
      });
    }
    set.delete('cep.zh.manager');
    set.delete('cep.zh.agent');
    return Array.from(set).sort(function (a, b) { return a.localeCompare(b); });
  }

  function pluginEntries(key) {
    var p = loadPlugin(key);
    var common = S.common.strings;
    var keys = new Set();
    Object.keys(p.user.strings || {}).forEach(function (k) { keys.add(k); });
    Object.keys(p.bundled.strings || {}).forEach(function (k) { keys.add(k); });
    var out = [];
    keys.forEach(function (orig) {
      if (isJunk(orig)) return;
      var uv = p.user.strings[orig] || '';
      var bv = p.bundled.strings[orig] || '';
      var cv = common[orig] || '';
      var tr = uv || bv || cv || '';
      var status = uv ? 'plugin' : (bv ? 'builtin' : (cv ? 'common' : 'untranslated'));
      out.push({ orig: orig, tr: tr, uv: uv, bv: bv, cv: cv, status: status });
    });
    out.sort(function (a, b) {
      var au = a.status === 'untranslated' ? 0 : 1;
      var bu = b.status === 'untranslated' ? 0 : 1;
      if (au !== bu) return au - bu;
      return a.orig.localeCompare(b.orig);
    });
    return out;
  }

  function pluginStats(key) {
    var e = pluginEntries(key);
    var stats = { total: e.length, translated: 0, common: 0, untranslated: 0 };
    e.forEach(function (x) {
      if (x.status === 'untranslated') stats.untranslated++;
      else if (x.status === 'common') stats.common++;
      else stats.translated++;
    });
    return stats;
  }

  function agentFresh() {
    if (!S.agent || !S.agent.updatedAt) return false;
    var t = Date.parse(S.agent.updatedAt);
    return Number.isFinite(t) && Date.now() - t < 8000;
  }
  function loadAgent() {
    S.agent = readJson(AGENT_STATE, null);
  }
  function loadControl() {
    var c = readJson(CONTROL, {});
    S.control = {
      enabled: c.enabled !== false,
      disabledPlugins: Array.isArray(c.disabledPlugins) ? c.disabledPlugins : [],
      collectToken: c.collectToken || '',
    };
  }
  function saveControl(patch) {
    var current = readJson(CONTROL, {});
    var next = Object.assign({}, current, patch || {});
    if (!Array.isArray(next.disabledPlugins)) next.disabledPlugins = [];
    if (writeJson(CONTROL, next)) {
      S.control = {
        enabled: next.enabled !== false,
        disabledPlugins: next.disabledPlugins,
        collectToken: next.collectToken || '',
      };
    }
  }

  function setGlobalEnabled(enabled) {
    saveControl({ enabled: enabled });
    $('globalToggle').checked = enabled;
    if ($('compactToggle')) $('compactToggle').checked = enabled;
    renderCompactStatus();
    $('agentStatus').textContent = 'AGENT / APPLYING…';
    toast(enabled ? '已开启全局汉化' : '已请求恢复原文');
    setTimeout(refreshAgent, 280);
    setTimeout(refreshAgent, 1100);
  }

  function applyCompactMode() {
    var width = document.documentElement.clientWidth || window.innerWidth || 0;
    var height = document.documentElement.clientHeight || window.innerHeight || 0;
    var compact = width > 0 && height > 0 && (width < 500 || height < 460);
    var micro = compact && (width < 320 || height < 320);
    document.body.classList.toggle('compact', compact);
    document.body.classList.toggle('micro', micro);
    var toggle = $('compactToggle');
    if (toggle) toggle.checked = S.control.enabled;
    renderCompactStatus();
  }

  function renderCompactStatus() {
    var state = $('compactState');
    var agent = $('compactAgent');
    if (state) state.textContent = S.control.enabled ? '已开启' : '已关闭';
    if (agent) {
      if (!S.agent || !agentFresh()) agent.textContent = 'AGENT / OFFLINE';
      else if (S.translationRunning) agent.textContent = 'AGENT / TRANSLATING';
      else agent.textContent = 'AGENT / RUNNING · ' + ((S.agent.panels || []).length) + ' PANELS';
    }
  }

  function hostInfo() {
    var env = {};
    try { env = JSON.parse(host.getHostEnvironment()); } catch (e) {}
    return env;
  }
  function applyTheme(mode) {
    S.theme = mode === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', S.theme);
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-theme]'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-set-theme') === S.theme);
    });
    try { localStorage.setItem('cepzh.theme.v3', S.theme); } catch (e) {}
  }

  function renderAbout() {
    var gh = $('githubUrl');
    var gl = $('githubLink');
    var bl = $('biliLink');
    if (gh) gh.textContent = GITHUB_URL;
    if (gl) gl.href = GITHUB_URL;
    if (bl) bl.href = BILI_URL;
  }

  /* ---------------- sidebar / views ---------------- */

  function switchView(view) {
    S.view = view;
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    $('viewPlugin').classList.toggle('hidden', view !== 'plugin');
    $('viewGlobal').classList.toggle('hidden', view !== 'global');
    $('viewSettings').classList.toggle('hidden', view !== 'settings');
    $('viewExport').classList.toggle('hidden', view !== 'export');
    $('viewAbout').classList.toggle('hidden', view !== 'about');
    $('sidePlugins').classList.toggle('hidden', view === 'settings' || view === 'export' || view === 'about');
    if (view === 'global') renderGlobal();
    if (view === 'settings') renderSettings();
    if (view === 'export') renderExport();
    if (view === 'about') renderAbout();
    if (view === 'plugin') renderPlugin();
  }

  function selectPlugin(key) {
    S.key = key;
    S.page = 1;
    S.filter = 'all';
    Array.prototype.forEach.call(document.querySelectorAll('#filterSeg button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-filter') === 'all');
    });
    switchView('plugin');
    renderPlugins();
  }

  function renderPlugins() {
    var keys = pluginKeys();
    var q = S.pluginSearch.trim().toLowerCase();
    var live = {};
    if (S.agent && Array.isArray(S.agent.panels)) S.agent.panels.forEach(function (p) { live[sanitizeKey(p.bundleId)] = true; });
    $('pluginCount').textContent = keys.length;
    var html = '';
    keys.forEach(function (key) {
      var p = loadPlugin(key);
      var st = pluginStats(key);
      var label = p.name || key;
      if (q && label.toLowerCase().indexOf(q) < 0 && key.toLowerCase().indexOf(q) < 0) return;
      html += '<div class="plugin-item' + (S.key === key ? ' active' : '') + (live[key] ? ' live' : '') + '" data-key="' + esc(key) + '">' +
        '<span class="dot"></span><span class="pname" title="' + esc(key) + '">' + esc(label) + '</span>' +
        (st.untranslated ? '<span class="pbadge">' + st.untranslated + '</span>' : '') +
        '<span class="pcount">' + st.total + '</span></div>';
    });
    $('pluginList').innerHTML = html || '<div class="empty">没有插件字典</div>';
    Array.prototype.forEach.call(document.querySelectorAll('.plugin-item'), function (el) {
      el.onclick = function () { selectPlugin(el.getAttribute('data-key')); };
    });
  }

  function renderHost() {
    var env = hostInfo();
    var name = env.appName || env.appId || 'Adobe';
    var ver = env.appVersion || '';
    var loc = env.appLocale || env.appUILocale || '';
    var line = $('hostLine');
    if (line) line.textContent = name + (ver ? ' ' + ver : '') + (env.appId ? ' · ' + env.appId : '') + (loc ? ' · ' + loc : '');
    $('dictPath').textContent = DICT;
    $('settingsPaths').textContent = '用户字典：' + DICT + '\n内置字典：' + BUNDLED + '\n控制：' + CONTROL + '\nAgent 状态：' + AGENT_STATE;
  }

  /* ---------------- table ---------------- */

  function statusLabel(status) {
    if (status === 'plugin') return '已翻译';
    if (status === 'builtin') return '内置';
    if (status === 'common') return '公共';
    return '未翻译';
  }
  function statusClass(status) {
    if (status === 'plugin' || status === 'builtin') return 'plugin';
    if (status === 'common') return 'common';
    return 'untranslated';
  }

  function filteredEntries(entries) {
    var q = S.search.trim().toLowerCase();
    return entries.filter(function (e) {
      if (S.filter === 'untranslated' && e.status !== 'untranslated') return false;
      if (S.filter === 'translated' && !(e.status === 'plugin' || e.status === 'builtin')) return false;
      if (S.filter === 'common' && e.status !== 'common') return false;
      if (!q) return true;
      return e.orig.toLowerCase().indexOf(q) >= 0 || (e.tr || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderPager(el, page, total, pageSize, cb) {
    var pages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, pages);
    el.innerHTML = '<span>' + (total ? ((page - 1) * pageSize + 1) + '–' + Math.min(total, page * pageSize) + ' / ' + total : '0 条') + '</span>' +
      '<button data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>‹</button>' +
      '<span>' + page + ' / ' + pages + '</span>' +
      '<button data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>›</button>';
    Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
      b.onclick = function () { cb(Number(b.getAttribute('data-page'))); };
    });
  }

  function renderPlugin() {
    if (!S.key) {
      $('dictSearch').value = S.search;
      $('pluginTitle').textContent = '选择一个插件';
      $('pluginMeta').textContent = '左侧选择插件，或打开一个 CEP 面板后点击“捕获已打开插件”。';
      $('pluginRows').innerHTML = '';
      $('pluginEmpty').classList.remove('hidden');
      $('pluginEmpty').textContent = '还没有选择插件';
      $('pluginStats').innerHTML = '';
      $('pluginPager').innerHTML = '';
      $('pluginToggle').checked = false;
      updateTranslationUI();
      return;
    }
    $('dictSearch').value = S.search;
    var p = loadPlugin(S.key);
    var entries = pluginEntries(S.key);
    var stats = pluginStats(S.key);
    var disabled = S.control.disabledPlugins.indexOf(S.key) >= 0 ||
      (S.agent && Array.isArray(S.agent.panels) && S.agent.panels.some(function (x) { return sanitizeKey(x.bundleId) === S.key && x.disabled; }));
    $('pluginTitle').textContent = p.name || S.key;
    $('pluginMeta').textContent = S.key + ' · ' + entries.length + ' 条词条 · 插件字典优先于公共字典';
    $('pluginToggle').checked = !disabled;
    $('pluginStats').innerHTML =
      '<div class="stat"><b>' + stats.total + '</b><span>总词条</span></div>' +
      '<div class="stat ok"><b>' + stats.translated + '</b><span>已翻译</span></div>' +
      '<div class="stat warn"><b>' + stats.common + '</b><span>公共回退</span></div>' +
      '<div class="stat bad"><b>' + stats.untranslated + '</b><span>未翻译</span></div>';

    var list = filteredEntries(entries);
    var page = Math.min(S.page, Math.max(1, Math.ceil(list.length / S.pageSize)));
    S.page = page;
    var slice = list.slice((page - 1) * S.pageSize, page * S.pageSize);
    var html = '';
    slice.forEach(function (e) {
      var badge = statusLabel(e.status);
      var cls = statusClass(e.status);
      html += '<tr data-orig="' + esc(e.orig) + '">' +
        '<td><div class="orig">' + esc(e.orig) + '</div></td>' +
        '<td><input class="tr-input" data-orig="' + esc(e.orig) + '" value="' + esc(e.tr) + '" placeholder="未翻译" /></td>' +
        '<td><span class="badge ' + cls + '">' + badge + '</span></td>' +
        '<td><button class="row-del" data-del="' + esc(e.orig) + '" title="删除该词条">×</button></td></tr>';
    });
    $('pluginRows').innerHTML = html;
    $('pluginEmpty').classList.toggle('hidden', list.length > 0);
    $('pluginEmpty').textContent = entries.length ? '没有匹配的词条' : '还没有词条。打开该插件后点击“捕获已打开插件”，或在右上方添加。';
    $('tableInfo').textContent = list.length + ' 条匹配';
    renderPager($('pluginPager'), page, list.length, S.pageSize, function (n) { S.page = n; renderPlugin(); });
    bindRows('plugin', S.key);
    updateTranslationUI();
  }

  function renderGlobal() {
    $('globalDictSearch').value = S.globalSearch;
    var keys = Object.keys(S.common.strings || {}).filter(function (k) { return !isJunk(k); });
    var entries = keys.map(function (orig) {
      var tr = S.common.strings[orig] || '';
      return { orig: orig, tr: tr, status: tr ? 'plugin' : 'untranslated' };
    }).sort(function (a, b) {
      var au = a.status === 'untranslated' ? 0 : 1, bu = b.status === 'untranslated' ? 0 : 1;
      if (au !== bu) return au - bu;
      return a.orig.localeCompare(b.orig);
    });
    var total = entries.length;
    var untranslated = entries.filter(function (e) { return !e.tr; }).length;
    $('globalStats').innerHTML =
      '<div class="stat"><b>' + total + '</b><span>总词条</span></div>' +
      '<div class="stat ok"><b>' + (total - untranslated) + '</b><span>已翻译</span></div>' +
      '<div class="stat bad"><b>' + untranslated + '</b><span>未翻译</span></div>';

    var q = S.globalSearch.trim().toLowerCase();
    var list = entries.filter(function (e) {
      if (S.globalFilter === 'untranslated' && e.tr) return false;
      if (S.globalFilter === 'translated' && !e.tr) return false;
      return !q || e.orig.toLowerCase().indexOf(q) >= 0 || (e.tr || '').toLowerCase().indexOf(q) >= 0;
    });
    var page = Math.min(S.globalPage, Math.max(1, Math.ceil(list.length / S.pageSize)));
    S.globalPage = page;
    var slice = list.slice((page - 1) * S.pageSize, page * S.pageSize);
    var html = '';
    slice.forEach(function (e) {
      html += '<tr data-orig="' + esc(e.orig) + '">' +
        '<td><div class="orig">' + esc(e.orig) + '</div></td>' +
        '<td><input class="tr-input" data-orig="' + esc(e.orig) + '" value="' + esc(e.tr) + '" placeholder="未翻译" /></td>' +
        '<td><span class="badge ' + (e.tr ? 'plugin' : 'untranslated') + '">' + (e.tr ? '已翻译' : '未翻译') + '</span></td>' +
        '<td><button class="row-del" data-del="' + esc(e.orig) + '" title="删除">×</button></td></tr>';
    });
    $('globalRows').innerHTML = html;
    $('globalEmpty').classList.toggle('hidden', list.length > 0);
    $('globalTableInfo').textContent = list.length + ' 条匹配';
    renderPager($('globalPager'), page, list.length, S.pageSize, function (n) { S.globalPage = n; renderGlobal(); });
    bindRows('global');
  }

  var saveTimers = {};
  function bindRows(kind, key) {
    Array.prototype.forEach.call(document.querySelectorAll((kind === 'plugin' ? '#pluginRows' : '#globalRows') + ' .tr-input'), function (inp) {
      var orig = inp.getAttribute('data-orig');
      var timerKey = kind + '|' + (key || '') + '|' + orig;
      inp.oninput = function () {
        clearTimeout(saveTimers[timerKey]);
        saveTimers[timerKey] = setTimeout(function () { saveValue(kind, key, orig, inp.value); }, 650);
      };
      inp.onkeydown = function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
      };
      inp.onblur = function () { saveValue(kind, key, orig, inp.value); };
    });
    Array.prototype.forEach.call(document.querySelectorAll((kind === 'plugin' ? '#pluginRows' : '#globalRows') + ' .row-del'), function (btn) {
      btn.onclick = function () { deleteValue(kind, key, btn.getAttribute('data-del')); };
    });
  }

  function saveValue(kind, key, orig, value) {
    value = String(value == null ? '' : value);
    if (kind === 'plugin') {
      if (!key) return;
      var p = loadPlugin(key);
      if (!p.user.strings) p.user.strings = {};
      p.user.strings[orig] = value;
      if (writeJson(EXT + '/' + key + '.json', p.user)) {
        if (S.view === 'plugin' && S.key === key) {
          $('pluginTitle').textContent = p.name || key;
          var st = pluginStats(key);
          $('pluginStats').innerHTML =
            '<div class="stat"><b>' + st.total + '</b><span>总词条</span></div>' +
            '<div class="stat ok"><b>' + st.translated + '</b><span>已翻译</span></div>' +
            '<div class="stat warn"><b>' + st.common + '</b><span>公共回退</span></div>' +
            '<div class="stat bad"><b>' + st.untranslated + '</b><span>未翻译</span></div>';
        }
      }
    } else {
      var file = DICT + '/global.json';
      var g = readJson(file, { name: 'Common CEP UI terms', strings: {} });
      if (!g.strings) g.strings = {};
      g.strings[orig] = value;
      if (writeJson(file, g)) { loadCommon(); if (S.view === 'global') renderGlobal(); }
    }
  }

  function deleteValue(kind, key, orig) {
    if (kind === 'plugin') {
      if (!key) return;
      var p = loadPlugin(key);
      delete p.user.strings[orig];
      if (writeJson(EXT + '/' + key + '.json', p.user)) { toast('已删除词条'); renderPlugin(); renderPlugins(); }
    } else {
      var file = DICT + '/global.json';
      var g = readJson(file, { strings: {} });
      delete g.strings[orig];
      if (writeJson(file, g)) { loadCommon(); renderGlobal(); toast('已删除公共词条'); }
    }
  }

  function clearPluginTranslations() {
    if (!S.key) { toast('先选择一个插件'); return; }
    var p = loadPlugin(S.key);
    var count = Object.keys(p.user.strings || {}).length;
    if (!count) { toast('当前插件没有本机译文'); return; }
    if (!confirm('清空 ' + (p.name || S.key) + ' 的本机译文？\n\n内置字典和公共字典会继续保留。')) return;
    p.user.strings = {};
    if (writeJson(EXT + '/' + S.key + '.json', p.user)) {
      S.sig = '';
      renderPlugin();
      renderPlugins();
      toast('已清空该插件的本机译文');
    }
  }

  /* ---------------- settings / agent ---------------- */

  function updateTranslationUI() {
    var running = !!S.translationRunning;
    if ($('btnAi')) {
      $('btnAi').disabled = running || !S.key;
      $('btnAi').textContent = running ? '翻译中…' : 'AI 翻译';
    }
    if ($('btnTranslateAll')) {
      $('btnTranslateAll').disabled = running;
      $('btnTranslateAll').textContent = running ? '翻译中…' : 'AI 翻译全部字典';
      $('btnTranslateAll').classList.toggle('running', running);
    }
    var clear = $('btnClearPlugin');
    if (clear) {
      var count = S.key ? Object.keys(loadPlugin(S.key).user.strings || {}).length : 0;
      clear.disabled = running || !S.key || count === 0;
      clear.textContent = '清空译文';
    }
  }

  function requestTranslate(scope) {
    if (S.translationRunning) { toast('已有翻译任务在运行'); return; }
    var cfg = readJson(CONFIG, {});
    if (!cfg.provider || cfg.provider === 'none') {
      toast('请先在设置里配置翻译 API', 2600);
      switchView('settings');
      return;
    }
    if (scope === 'plugin' && !S.key) { toast('先选择一个插件'); return; }
    var current = readJson(CONTROL, {});
    current.translationTask = {
      token: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      scope: scope === 'all' ? 'all' : 'plugin',
      bundleId: scope === 'all' ? '' : S.key,
    };
    if (!writeJson(CONTROL, current)) return;
    S.translationRunning = true;
    updateTranslationUI();
    $('agentStatus').textContent = 'TRANSLATE / QUEUED';
    toast(scope === 'all' ? '已请求 AI 翻译全部字典' : '已请求 AI 翻译当前插件', 2600);
    setTimeout(refreshAgent, 300);
    setTimeout(refreshAgent, 1200);
  }

  function ensureSelectedExports(keys) {
    if (!(S.exportSelected instanceof Set)) S.exportSelected = new Set(keys);
    var valid = new Set(keys);
    Array.from(S.exportSelected).forEach(function (k) { if (!valid.has(k)) S.exportSelected.delete(k); });
  }

  function renderExport() {
    var keys = pluginKeys();
    ensureSelectedExports(keys);
    var list = $('exportList');
    var html = '';
    keys.forEach(function (key) {
      var p = loadPlugin(key);
      var st = pluginStats(key);
      html += '<label class="export-item"><input type="checkbox" data-export-key="' + esc(key) + '"' +
        (S.exportSelected.has(key) ? ' checked' : '') + ' />' +
        '<span class="ename" title="' + esc(key) + '">' + esc(p.name || key) + '</span>' +
        '<span class="ecount">' + st.total + '</span></label>';
    });
    list.innerHTML = html || '<div class="empty">没有插件字典</div>';
    Array.prototype.forEach.call(list.querySelectorAll('input[data-export-key]'), function (cb) {
      cb.onchange = function () {
        var k = cb.getAttribute('data-export-key');
        if (cb.checked) S.exportSelected.add(k); else S.exportSelected.delete(k);
        renderExport();
      };
    });
    $('exportCount').textContent = S.exportSelected.size + ' / ' + keys.length;
    $('btnExport').disabled = S.exportSelected.size === 0;
    $('importOverwrite').checked = !!S.importOverwrite;
    $('exportLog').textContent = S.exportLog;
  }

  function chooseFolder(title) {
    if (!FS || !FS.showOpenDialog) return null;
    var r = FS.showOpenDialog(false, true, title, '');
    if (!r || r.err !== 0 || !r.data) return null;
    var list = Array.isArray(r.data) ? r.data : [r.data];
    return list.length ? nativePath(list[0]) : null;
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function exportTo(parent) {
    var keys = Array.from(S.exportSelected || []).filter(function (k) { return pluginKeys().indexOf(k) >= 0; });
    if (!keys.length) { toast('至少选择一个插件'); return null; }
    var base = parent.replace(/\/+$/, '') + '/CEP-ZH-dict-' + stamp();
    var folder = base;
    var n = 1;
    while (FS.readdir(folder).err === 0 && n < 100) { folder = base + '-' + n; n++; }
    ensureDir(folder);
    var written = [];
    keys.forEach(function (key) {
      var p = loadPlugin(key);
      var all = new Set(Object.keys(p.bundled.strings || {}).concat(Object.keys(p.user.strings || {})));
      var strings = {};
      all.forEach(function (s) {
        var t = (p.user.strings && p.user.strings[s]) || (p.bundled.strings && p.bundled.strings[s]) || '';
        strings[s] = t;
      });
      if (writeJson(folder + '/' + key + '.json', { name: p.name || key, strings: strings, patterns: p.user.patterns || [] })) written.push(key);
    });
    writeJson(folder + '/_export.json', {
      app: 'CEP-ZH', version: '0.2.0', exportedAt: new Date().toISOString(), files: written,
    });
    S.exportLog = '已导出 ' + written.length + ' 个插件字典\n' + folder;
    renderExport();
    toast('已导出 ' + written.length + ' 个字典文件', 2600);
    return folder;
  }

  function exportDictionaries() {
    var parent = chooseFolder('选择导出位置');
    if (parent) exportTo(parent);
  }

  function importFrom(folder) {
    var files = [];
    function addDir(dir) {
      listDir(dir).forEach(function (name) {
        if (!/\.json$/i.test(name) || /^_/.test(name)) return;
        var data = readJson(dir + '/' + name, null);
        if (!data || typeof data.strings !== 'object' || !data.strings) return;
        files.push({ name: name, data: data });
      });
    }
    addDir(folder);
    addDir(folder + '/extensions');
    if (!files.length) {
      S.exportLog = '没有在文件夹中找到有效的字典 JSON\n' + folder;
      renderExport();
      toast('没有找到可导入的字典');
      return;
    }
    var stat = { files: 0, entries: 0, global: 0 };
    files.forEach(function (item) {
      var name = item.name;
      var data = item.data;
      if (name.toLowerCase() === 'global.json') {
        var g = readJson(DICT + '/global.json', { name: 'Common CEP UI terms', strings: {} });
        if (!g.strings) g.strings = {};
        Object.keys(data.strings).forEach(function (s) {
          var t = data.strings[s];
          if (typeof t !== 'string') return;
          if (t && (S.importOverwrite || !g.strings[s])) { g.strings[s] = t; stat.global++; }
          else if (!t && !(s in g.strings)) g.strings[s] = '';
        });
        writeJson(DICT + '/global.json', g);
      } else {
        var key = sanitizeKey(name.replace(/\.json$/i, ''));
        var local = readJson(EXT + '/' + key + '.json', { name: key, strings: {}, patterns: [] });
        if (!local.strings) local.strings = {};
        Object.keys(data.strings).forEach(function (s) {
          var t = data.strings[s];
          if (typeof t !== 'string') return;
          if (t && (S.importOverwrite || !local.strings[s])) { local.strings[s] = t; stat.entries++; }
          else if (!t && !(s in local.strings)) local.strings[s] = '';
        });
        local.name = local.name || data.name || key;
        if (writeJson(EXT + '/' + key + '.json', local)) stat.files++;
      }
    });
    S.exportLog = '导入完成：' + stat.files + ' 个插件文件，' + stat.entries + ' 条插件译文，' +
      stat.global + ' 条公共译文\n' + folder;
    loadCommon();
    S.sig = '';
    renderPlugins();
    renderExport();
    toast('导入完成：' + stat.files + ' 个插件文件', 3000);
    return stat;
  }

  function importDictionaries() {
    var folder = chooseFolder('选择字典文件夹');
    if (folder) importFrom(folder);
  }

  function renderSettings() {
    var cfg = readJson(CONFIG, {});
    if (!S.apiDirty) {
      $('apiProvider').value = cfg.provider || 'none';
      $('apiBase').value = cfg.baseUrl || '';
      $('apiModel').value = cfg.model || '';
      $('apiKey').value = cfg.apiKey || '';
      $('apiLang').value = cfg.targetLang || 'zh-CN';
    }
    var a = S.agent;
    var lines = [];
    if (a) {
      lines.push('AGENT / ' + (agentFresh() ? 'RUNNING' : 'STALE'));
      lines.push('PID    ' + (a.agentPid || '-'));
      lines.push('SYNC   ' + (a.updatedAt || '-'));
      lines.push('GLOBAL ' + (a.enabled !== false ? 'ON' : 'OFF'));
      lines.push('PANELS ' + ((a.panels || []).length));
      (a.panels || []).slice(0, 12).forEach(function (p) {
        lines.push('  :' + p.port + '  ' + (p.bundleId || p.extId || '?') + '  ' + (p.injected ? 'ON' : 'OFF') + (p.disabled ? ' / DISABLED' : ''));
      });
    } else {
      lines.push('AGENT / OFFLINE');
      lines.push('请确认隐藏扩展 cep.zh.agent 已启动。');
    }
    $('agentDetail').textContent = lines.join('\n');
    var all = $('btnRepairAllDebug');
    if (all) {
      var count = pendingDebug().length;
      all.disabled = !!S.repairToken || repairRunning() || count === 0;
      all.textContent = count ? ('修复全部 .debug · ' + count) : '修复全部 .debug';
    }
  }

  function pendingDebug() {
    return S.agent && Array.isArray(S.agent.pendingDebug) ? S.agent.pendingDebug : [];
  }

  function repairRunning() {
    var rep = S.agent && S.agent.lastRepair;
    return !!(rep && rep.status === 'running');
  }

  function requestDebugRepair() {
    if (S.repairToken) return;
    if (repairRunning()) {
      toast('修复正在进行，请等待当前管理员进程完成');
      return;
    }
    if (!pendingDebug().length) {
      toast('没有缺失 .debug 的插件');
      return;
    }
    var token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    S.repairToken = token;
    S.repairToastToken = '';
    saveControl({ repairDebugToken: token, repairDebugRequestedAt: Date.now() });
    renderDebugNotice();
    toast('已请求修复全部缺失 .debug；如弹出 UAC 请选择“是”…', 4000);
    setTimeout(refreshAgent, 500);
  }

  function renderDebugNotice() {
    var pending = pendingDebug();
    var badge = $('debugBadge');
    var notice = $('debugNotice');
    var overlay = $('debugOverlay');
    if (!badge || !notice) return;

    var n = pending.length;
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);

    if (!n) {
      notice.classList.add('hidden');
      if (overlay) overlay.classList.add('hidden');
      document.body.classList.remove('has-debug');
      S.debugSig = '';
      return;
    }

    var sig = pending.map(function (p) { return p.path || p.bundleId || ''; }).join('|');
    S.debugSig = sig;
    if (S.debugDismissed === sig) {
      notice.classList.add('hidden');
      if (overlay) overlay.classList.add('hidden');
      document.body.classList.remove('has-debug');
      return;
    }

    var names = pending.slice(0, 2).map(function (p) {
      return p.bundleId || p.path || '未命名插件';
    }).join('、');
    var unwritable = pending.filter(function (p) { return !p.writable; }).length;
    var title = '发现 ' + n + ' 个插件缺少 .debug';
    var sub = names + (n > 2 ? ' 等' : '') + ' · CEP9–11 需要补写；CEP12 代理已覆盖的插件可忽略。';
    if (unwritable) sub += ' 系统目录将请求管理员权限。';
    if (S.repairToken) sub = '已请求修复，正在等待管理员写入；如出现 UAC 请选择“是”。';

    $('debugTitle').textContent = title;
    $('debugSub').textContent = sub;
    var busy = !!S.repairToken || repairRunning();
    $('btnRepairDebug').disabled = busy;
    var all = $('btnRepairAllDebug');
    if (all) {
      all.disabled = busy || n === 0;
      all.textContent = n ? ('修复全部 .debug · ' + n) : '修复全部 .debug';
    }
    notice.classList.remove('hidden');
    if (overlay) overlay.classList.remove('hidden');
    document.body.classList.add('has-debug');
  }

  function refreshAgent() {
    loadAgent();
    var fresh = agentFresh();
    var tr = S.agent && S.agent.translation;
    S.translationRunning = !!(tr && tr.running);
    if (fresh) {
      if (tr && tr.running) {
        $('agentStatus').textContent = 'TRANSLATE / ' + (tr.done || 0) + ' / ' + (tr.total || 0);
      } else {
        $('agentStatus').textContent = 'AGENT / RUNNING · ' + ((S.agent.panels || []).length) + ' PANELS';
      }
      var last = S.agent.lastCollect;
      $('lastCollect').textContent = last ? ('CAPTURE / +' + last.added + ' · ' + (last.at || '')) : '';
    } else {
      $('agentStatus').textContent = 'AGENT / OFFLINE';
      $('lastCollect').textContent = '';
    }
    if (tr && !tr.running && tr.token && tr.token !== S.lastTranslationSeen) {
      S.lastTranslationSeen = tr.token;
      S.translationRunning = false;
      var ctl = readJson(CONTROL, {});
      if (ctl.translationTask && ctl.translationTask.token === tr.token) {
        delete ctl.translationTask;
        writeJson(CONTROL, ctl);
      }
      if (tr.error) {
        toast('AI 翻译失败：' + tr.error, 6000);
      } else {
        toast('AI 翻译完成：+' + (tr.translated || 0) + ' 条，跳过 ' + (tr.skipped || 0) + ' 条', 4200);
        S.sig = '';
        setTimeout(function () {
          loadCommon();
          renderPlugins();
          if (S.view === 'plugin') renderPlugin();
          else if (S.view === 'global') renderGlobal();
        }, 260);
      }
    }
    var rep = S.agent && S.agent.lastRepair;
    if (S.repairToken && rep && rep.token === S.repairToken && rep.status !== 'running') {
      var remaining = pendingDebug().length;
      var failed = rep.status === 'error';
      var finished = rep.status === 'done' || (rep.status === 'elevated' && remaining === 0);
      var stale = rep.status === 'elevated' && rep.at && (Date.now() - Date.parse(rep.at) > 120000);
      if (finished || failed || stale) {
        if (S.repairToastToken !== rep.token) {
          S.repairToastToken = rep.token;
          if (finished) toast(rep.message || '已写入 .debug，请重启 Adobe 应用', 5000);
          else toast(failed ? ('修复失败：' + (rep.message || '未知错误')) : '等待管理员写入超时，可重试', 5000);
        }
        S.repairToken = '';
        saveControl({ repairDebugToken: '', repairDebugRequestedAt: 0 });
        setTimeout(refreshAgent, 400);
      }
    }
    var auto = S.agent && S.agent.lastAutoDebug;
    if (auto && auto.at && auto.count > 0 && auto.at !== S.lastAutoSeen &&
        Date.now() - Date.parse(auto.at) < 120000) {
      S.lastAutoSeen = auto.at;
      if (auto.status === 'done') toast(auto.message || '新插件已自动写入 .debug，请重启 Adobe 应用', 5200);
      else toast(auto.message || '部分新插件需要手动修复', 5200);
    }
    renderDebugNotice();
    renderCompactStatus();
    updateTranslationUI();
    if (S.view === 'settings') renderSettings();
  }

  function openExternal(url) {
    try {
      if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
        return;
      }
    } catch (e) {}
    try { window.open(url, '_blank'); } catch (e) {}
  }

  function parseVersion(v) {
    return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map(function (x) {
      var n = parseInt(x, 10);
      return isFinite(n) ? n : 0;
    });
  }

  function isNewerVersion(latest, current) {
    var a = parseVersion(latest), b = parseVersion(current);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  function showUpdateBanner(tag) {
    var version = String(tag || '').replace(/^v/i, '');
    if (!version || !isNewerVersion(version, APP_VERSION)) return;
    try {
      if (localStorage.getItem(UPDATE_DISMISS_KEY) === version) return;
    } catch (e) {}
    $('updateVersion').textContent = 'v' + version;
    $('updateNotice').classList.remove('hidden');
    $('updateNotice').setAttribute('data-tag', version);
  }

  function checkForUpdates() {
    try {
      var checked = Number(localStorage.getItem(UPDATE_CHECK_KEY) || 0);
      if (Date.now() - checked < 6 * 3600 * 1000) return;
    } catch (e) {}
    var xhr = new XMLHttpRequest();
    xhr.open('GET', LATEST_RELEASE_API, true);
    xhr.timeout = 12000;
    xhr.setRequestHeader('Accept', 'application/vnd.github+json');
    xhr.onload = function () {
      try { localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now())); } catch (e) {}
      if (xhr.status < 200 || xhr.status >= 300) return;
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { return; }
      if (!data || !data.tag_name) return;
      showUpdateBanner(data.tag_name);
    };
    xhr.onerror = xhr.ontimeout = function () {};
    xhr.send();
  }

  /* ---------------- actions ---------------- */

  function requestCollect() {
    var token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    saveControl({ collectToken: token });
    toast('已请求捕获，Agent 正在扫描面板…', 2400);
    setTimeout(function () { refreshAgent(); loadCommon(); renderPlugins(); if (S.view === 'plugin') renderPlugin(); }, 1600);
    setTimeout(function () { refreshAgent(); loadCommon(); renderPlugins(); if (S.view === 'plugin') renderPlugin(); }, 3500);
  }

  function saveSettings() {
    var cfg = readJson(CONFIG, {});
    cfg.provider = $('apiProvider').value;
    cfg.baseUrl = $('apiBase').value.trim();
    cfg.model = $('apiModel').value.trim();
    cfg.apiKey = $('apiKey').value.trim();
    cfg.targetLang = $('apiLang').value.trim() || 'zh-CN';
    if (writeJson(CONFIG, cfg)) {
      S.apiDirty = false;
      toast('API 配置已保存（本机）');
    }
  }

  function openAdd(kind) {
    if (kind === 'plugin' && !S.key) { toast('先选择一个插件'); return; }
    S.addKind = kind;
    $('addTitle').textContent = kind === 'plugin' ? ('添加到 ' + (S.key || '插件')) : '添加公共词条';
    $('addOriginal').value = '';
    $('addTranslation').value = '';
    $('addDialog').showModal();
    setTimeout(function () { $('addOriginal').focus(); }, 30);
  }

  function submitAdd(ev) {
    ev.preventDefault();
    var orig = $('addOriginal').value.trim();
    var tr = $('addTranslation').value;
    if (!orig) return;
    if (S.addKind === 'plugin') {
      if (!S.key) return;
      var p = loadPlugin(S.key);
      p.user.strings[orig] = tr;
      writeJson(EXT + '/' + S.key + '.json', p.user);
    } else {
      var g = readJson(DICT + '/global.json', { name: 'Common CEP UI terms', strings: {} });
      g.strings[orig] = tr;
      writeJson(DICT + '/global.json', g);
      loadCommon();
    }
    $('addDialog').close();
    renderPlugins();
    if (S.view === 'plugin') renderPlugin(); else if (S.view === 'global') renderGlobal();
    toast('已添加词条');
  }

  /* ---------------- wiring ---------------- */

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
      b.onclick = function () {
        if (b.getAttribute('data-view') === 'plugin' && !S.key) {
          var keys = pluginKeys();
          if (keys.length) S.key = keys[0];
        }
        switchView(b.getAttribute('data-view'));
      };
    });
    $('pluginSearch').oninput = function () {
      S.pluginSearch = this.value;
      renderPlugins();
    };
    $('dictSearch').oninput = function () {
      S.search = this.value;
      S.page = 1;
      renderPlugin();
    };
    $('globalDictSearch').oninput = function () {
      S.globalSearch = this.value;
      S.globalPage = 1;
      renderGlobal();
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-theme]'), function (b) {
      b.onclick = function () { applyTheme(b.getAttribute('data-set-theme')); };
    });
    $('globalToggle').onchange = function () {
      setGlobalEnabled(this.checked);
    };
    if ($('compactToggle')) {
      $('compactToggle').onchange = function () {
        setGlobalEnabled(this.checked);
      };
    }
    $('btnRepairDebug').onclick = requestDebugRepair;
    $('btnDismissDebug').onclick = function () {
      S.debugDismissed = S.debugSig;
      renderDebugNotice();
    };
    if ($('btnRepairAllDebug')) $('btnRepairAllDebug').onclick = requestDebugRepair;
    if ($('btnUpdate')) {
      $('btnUpdate').onclick = function () { openExternal(RELEASES_URL); };
    }
    if ($('btnUpdateDismiss')) {
      $('btnUpdateDismiss').onclick = function () {
        var tag = $('updateNotice').getAttribute('data-tag') || '';
        try { if (tag) localStorage.setItem(UPDATE_DISMISS_KEY, tag); } catch (e) {}
        $('updateNotice').classList.add('hidden');
      };
    }
    $('pluginToggle').onchange = function () {
      if (!S.key) return;
      var disabled = S.control.disabledPlugins.slice();
      var idx = disabled.indexOf(S.key);
      if (this.checked) { if (idx >= 0) disabled.splice(idx, 1); }
      else { if (idx < 0) disabled.push(S.key); }
      saveControl({ disabledPlugins: disabled });
      $('agentStatus').textContent = 'AGENT / APPLYING…';
      toast(this.checked ? '该插件已开启汉化' : '该插件已恢复原文');
      setTimeout(refreshAgent, 280);
      setTimeout(refreshAgent, 1100);
    };
    $('btnCollect').onclick = requestCollect;
    $('btnRefresh').onclick = function () {
      refreshAgent(); loadControl(); loadCommon();
      var before = JSON.stringify(S.common);
      renderPlugins(); renderHost();
      if (S.view === 'plugin') renderPlugin(); else if (S.view === 'global') renderGlobal();
      toast('已刷新');
    };
    $('btnAdd').onclick = function () { openAdd('plugin'); };
    $('btnClearPlugin').onclick = clearPluginTranslations;
    $('btnAddCommon').onclick = function () { openAdd('global'); };
    $('btnAi').onclick = function () { requestTranslate('plugin'); };
    $('btnTranslateAll').onclick = function () { requestTranslate('all'); };
    $('btnExport').onclick = exportDictionaries;
    $('btnExportAll').onclick = function () {
      S.exportSelected = new Set(pluginKeys());
      renderExport();
    };
    $('btnExportNone').onclick = function () {
      S.exportSelected = new Set();
      renderExport();
    };
    $('btnImport').onclick = importDictionaries;
    $('importOverwrite').onchange = function () { S.importOverwrite = this.checked; };
    $('btnSaveApi').onclick = saveSettings;
    $('btnRefreshAgent').onclick = function () { refreshAgent(); toast('Agent 状态已刷新'); };
    ['apiProvider', 'apiBase', 'apiModel', 'apiKey', 'apiLang'].forEach(function (id) {
      $(id).onfocus = function () { S.apiDirty = true; };
      $(id).oninput = function () { S.apiDirty = true; };
      $(id).onchange = function () { S.apiDirty = true; };
    });
    $('addCancel').onclick = function () { $('addDialog').close(); };
    $('addForm').onsubmit = submitAdd;

    Array.prototype.forEach.call(document.querySelectorAll('#filterSeg button'), function (b) {
      b.onclick = function () {
        S.filter = b.getAttribute('data-filter'); S.page = 1;
        Array.prototype.forEach.call(document.querySelectorAll('#filterSeg button'), function (x) { x.classList.toggle('active', x === b); });
        renderPlugin();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#globalFilterSeg button'), function (b) {
      b.onclick = function () {
        S.globalFilter = b.getAttribute('data-filter'); S.globalPage = 1;
        Array.prototype.forEach.call(document.querySelectorAll('#globalFilterSeg button'), function (x) { x.classList.toggle('active', x === b); });
        renderGlobal();
      };
    });

    document.addEventListener('keydown', function (ev) {
      var tag = (ev.target && ev.target.tagName) || '';
      var editing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (ev.key === '/' && !editing) {
        ev.preventDefault();
        var input = S.view === 'global' ? $('globalDictSearch') : $('dictSearch');
        input.focus();
        input.select();
      } else if (ev.key === 'Escape') {
        var active = document.activeElement;
        if (active === $('pluginSearch')) {
          active.value = '';
          S.pluginSearch = '';
          renderPlugins();
        } else if (active === $('dictSearch')) {
          active.value = '';
          S.search = '';
          renderPlugin();
        } else if (active === $('globalDictSearch')) {
          active.value = '';
          S.globalSearch = '';
          renderGlobal();
        }
        if (active && active.blur) active.blur();
      }
    });
  }

  function dataSignature() {
    var user = S.key ? readJson(EXT + '/' + S.key + '.json', null) : null;
    var bundled = S.key ? readJson(BUNDLED + '/extensions/' + S.key + '.json', null) : null;
    var panels = (S.agent && Array.isArray(S.agent.panels) ? S.agent.panels : []).map(function (p) {
      return [p.bundleId || '', p.port, !!p.injected, !!p.disabled];
    });
    return JSON.stringify([
      S.common.strings,
      S.key,
      user,
      bundled,
      listDir(EXT).join('|'),
      listDir(BUNDLED + '/extensions').join('|'),
      panels,
    ]);
  }

  function poll() {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
    refreshAgent();
    loadControl();
    if (!typing) {
      loadCommon();
      var sig = dataSignature();
      if (sig !== S.sig) {
        S.sig = sig;
        renderPlugins();
        if (S.view === 'plugin' && S.key) renderPlugin();
        else if (S.view === 'global') renderGlobal();
        else if (S.view === 'settings') renderSettings();
      }
    }
    $('globalToggle').checked = S.control.enabled;
    if ($('compactToggle')) $('compactToggle').checked = S.control.enabled;
    applyCompactMode();
    if (S.view === 'plugin' && S.key) {
      var disabled = S.control.disabledPlugins.indexOf(S.key) >= 0;
      $('pluginToggle').checked = !disabled;
    }
  }

  function init() {
    if (!host || !FS) {
      document.body.innerHTML = '<div style="padding:24px;color:#ddd;font:13px sans-serif">CEP API / cep.fs 不可用，无法读写字典。</div>';
      return;
    }
    seedDefaults();
    loadCommon();
    loadControl();
    loadAgent();
    S.lastTranslationSeen = (S.agent && S.agent.translation && S.agent.translation.token) || '';
    var theme = 'dark';
    try {
      var saved = localStorage.getItem('cepzh.theme.v3');
      if (saved === 'light' || saved === 'dark') theme = saved;
    } catch (e) {}
    applyTheme(theme);
    renderHost();
    renderPlugins();
    var keys = pluginKeys();
    var liveKeys = (S.agent && Array.isArray(S.agent.panels) ? S.agent.panels : [])
      .map(function (p) { return sanitizeKey(p.bundleId); });
    S.key = null;
    var bestScore = -1;
    for (var i = 0; i < keys.length; i++) {
      if (liveKeys.indexOf(keys[i]) < 0) continue;
      var st = pluginStats(keys[i]);
      var score = st.total + (st.untranslated ? 1000 : 0);
      if (score > bestScore) { bestScore = score; S.key = keys[i]; }
    }
    if (!S.key) {
      for (var j = 0; j < keys.length; j++) {
        if (pluginStats(keys[j]).total > 0) { S.key = keys[j]; break; }
      }
    }
    if (!S.key && keys.length) S.key = keys[0];
    bind();
    switchView('plugin');
    refreshAgent();
    $('globalToggle').checked = S.control.enabled;
    if ($('compactToggle')) $('compactToggle').checked = S.control.enabled;
    S.sig = dataSignature();
    applyCompactMode();
    window.addEventListener('resize', applyCompactMode);
    setTimeout(checkForUpdates, 1500);
    setInterval(poll, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

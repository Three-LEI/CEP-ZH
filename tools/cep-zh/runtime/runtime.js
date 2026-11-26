/* cep-zh runtime: translate a CEP panel's DOM in place.
 *
 * Injected by the cep-zh agent over the Chrome DevTools Protocol, either with
 * Runtime.evaluate (current document) or Page.addScriptToEvaluateOnNewDocument
 * (future documents / reloads). It must stay dependency-free and ES5-friendly
 * because CEP 9/10 ship Chromium 61/69.
 *
 * Configuration is read from window.__CEP_ZH_CONFIG__:
 *   { version, extId, bundleId, dict: {en: zh, ...}, patterns: [{re, flags, to}] }
 */
(function () {
  'use strict';

  var CFG = window.__CEP_ZH_CONFIG__ || {};
  var VERSION = '1.5.0';
  var dict = CFG.dict || {};
  var lowerDict = {};
  var patterns = [];

  for (var dk in dict) {
    if (!Object.prototype.hasOwnProperty.call(dict, dk) || !dict[dk]) continue;
    var lk = dk.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(lowerDict, lk)) lowerDict[lk] = dict[dk];
  }

  (CFG.patterns || []).forEach(function (p) {
    try { patterns.push({ re: new RegExp(p.re, p.flags || ''), to: p.to }); } catch (e) { /* ignore bad rule */ }
  });

  function exactLookup(key) {
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(dict, key) && dict[key]) return dict[key];
    var lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(lowerDict, lower)) return lowerDict[lower];
    return null;
  }

  function variantLookup(value) {
    if (!value) return null;
    var prefix = '';
    var suffix = '';
    var base = value;

    // Preserve leading bullets/punctuation: "• Amount:", "[Default]".
    var lead = /^([\s:：()\[\]（），,。.;；…•·\-–—]+)/.exec(base);
    if (lead) {
      prefix = lead[1];
      base = base.slice(prefix.length).trim();
    }

    // Preserve a trailing shortcut/parenthetical: "Save (Ctrl+S)".
    var paren = /(\s*[\(\（][^\)\）]{1,60}[\)\）])$/.exec(base);
    if (paren) {
      suffix = paren[1] + suffix;
      base = base.slice(0, -paren[1].length).trim();
    }

    // Strip trailing punctuation, numbers and placeholders in either order:
    // "Amount:", "Color 1", "EaseOut(", "Amount: %s".
    for (var pass = 0; pass < 4; pass++) {
      var punct = /([\s:：()\[\]（），,。.;；…]+)$/.exec(base);
      if (punct) {
        suffix = punct[1] + suffix;
        base = base.slice(0, -punct[1].length).trim();
        continue;
      }
      var ending = /(\s+\d+)$/.exec(base);
      if (ending) {
        suffix = ending[1] + suffix;
        base = base.slice(0, -ending[1].length).trim();
        continue;
      }
      var placeholder = /(\s*(?:%[0-9$]*[sdif]|\{[^{}]+\}|<[^<>]+>|\[[A-Za-z0-9 _.-]+\]))$/.exec(base);
      if (placeholder) {
        suffix = placeholder[1] + suffix;
        base = base.slice(0, -placeholder[1].length).trim();
        continue;
      }
      break;
    }

    if (!base || base === value) return null;
    var translated = exactLookup(base);
    if (!translated) return null;
    return prefix + translated + suffix.replace(/:/g, '：');
  }

  function lookup(key) {
    if (!key) return null;
    var direct = exactLookup(key);
    if (direct) return direct;
    var compact = key.replace(/\s+/g, ' ').trim();
    if (compact !== key) {
      direct = exactLookup(compact);
      if (direct) return direct;
    }

    var variant = variantLookup(compact);
    if (variant) return variant;

    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      p.re.lastIndex = 0;
      if (p.re.test(compact)) {
        p.re.lastIndex = 0;
        var t = compact.replace(p.re, p.to);
        if (t && t !== compact) return t;
      }
    }
    return null;
  }

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, CODE: 1, PRE: 1,
    SVG: 1, CANVAS: 1, TEXTAREA: 1, IFRAME: 1, OBJECT: 1, EMBED: 1
  };
  var DEFAULT_ATTRS = [
    'title', 'placeholder', 'aria-label', 'aria-placeholder',
    'aria-description', 'aria-roledescription', 'aria-valuetext',
    'alt', 'tooltip', 'data-pt-title', 'data-tooltip', 'data-title',
    'data-tip', 'data-original-title', 'data-placeholder', 'label'
  ];
  var ATTRS = DEFAULT_ATTRS.slice();
  (CFG.attrs || []).forEach(function (name) {
    if (name && ATTRS.indexOf(name) < 0) ATTRS.push(name);
  });

  var textNodes = [];        // changed text nodes, for off()
  var attrEls = [];          // changed elements, for off()
  var originalText = [];     // parallel to textNodes: original values
  var originalAttrs = [];    // parallel to attrEls: {attr: value}
  // english source lookup, so a capture never has to turn translation off
  var originalTextMap = new WeakMap();   // text node -> English source
  var originalAttrMap = new WeakMap();   // element -> { attr: English source }
  var changedCount = 0;
  var mutationCount = 0;
  var lastError = '';
  var scanning = false;
  var observers = [];
  var observedRoots = [];
  var attachedDocs = [];
  var timers = [];
  var enabled = true;
  var activityEpoch = 0;
  var activityKind = '';
  var lastActivityAt = 0;
  var lastHref = location.href;

  function markActivity(kind) {
    activityEpoch++;
    activityKind = kind || 'activity';
    lastActivityAt = Date.now();
    // Push the hint to the Agent through the CDP binding it may have installed
    // (Runtime.addBinding). Without it the Agent still polls stats every second,
    // so this is a latency optimisation, never a requirement.
    try {
      if (typeof window.__cepZhActivity === 'function') {
        window.__cepZhActivity(String(activityEpoch) + '|' + activityKind);
      }
    } catch (e) {}
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function translateTextNode(node) {
    if (!enabled || !node || node.nodeType !== 3) return 0;
    var parent = node.parentElement;
    if (!parent || shouldSkipElement(parent)) return 0;
    if (parent.closest && parent.closest('[contenteditable="true"], .notranslate, [translate="no"]')) return 0;
    var value = node.nodeValue;
    if (!value || value.length > 400) return 0;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    if (!m) return 0;
    var key = m[2];
    if (!key || !/[A-Za-z\u00C0-\u024F]/.test(key)) return 0;
    var translated = lookup(key);
    if (translated === null || translated === key) return 0;
    var idx = textNodes.indexOf(node);
    if (idx < 0) {
      textNodes.push(node);
      originalText.push(value);
    } else if (originalText[idx] !== value) {
      // A framework rewrote an already-translated node: the newest English wins.
      originalText[idx] = value;
    }
    originalTextMap.set(node, value);
    node.nodeValue = m[1] + translated + m[3];
    changedCount++;
    return 1;
  }

  function shouldSkipAttrs(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function translateAttrs(el) {
    if (!enabled || !el || el.nodeType !== 1) return 0;
    if (shouldSkipAttrs(el)) return 0;
    var hit = 0;
    for (var i = 0; i < ATTRS.length; i++) {
      var name = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(name)) continue;
      var value = el.getAttribute(name);
      if (!value) continue;
      var translated = lookup(value);
      if (translated === null || translated === value) continue;
      var pos = attrEls.indexOf(el);
      if (pos < 0) { attrEls.push(el); originalAttrs.push({}); pos = attrEls.length - 1; }
      if (originalAttrs[pos][name] !== value) originalAttrs[pos][name] = value;
      var attrMap = originalAttrMap.get(el);
      if (!attrMap) { attrMap = {}; originalAttrMap.set(el, attrMap); }
      attrMap[name] = value;
      el.setAttribute(name, translated);
      hit++;
    }
    if (el.tagName === 'INPUT') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') {
        var val = el.value;
        if (val) {
          var t = lookup(val);
          if (t !== null && t !== val) {
            var p = attrEls.indexOf(el);
            if (p < 0) { attrEls.push(el); originalAttrs.push({}); p = attrEls.length - 1; }
            if (originalAttrs[p]['@value'] !== val) originalAttrs[p]['@value'] = val;
            var vMap = originalAttrMap.get(el);
            if (!vMap) { vMap = {}; originalAttrMap.set(el, vMap); }
            vMap['@value'] = val;
            el.value = t;
            hit++;
          }
        }
      }
    }
    return hit;
  }

  function scanNode(root) {
    if (!enabled || !root) return 0;
    var count = 0;
    if (root.nodeType === 3) return translateTextNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return 0;

    var walker;
    try {
      var doc = root.nodeType === 9 ? root : (root.ownerDocument || document);
      var filter = (doc.defaultView && doc.defaultView.NodeFilter) || NodeFilter;
      walker = doc.createTreeWalker(root, filter.SHOW_TEXT | filter.SHOW_ELEMENT, {
        acceptNode: function (n) {
          if (n.nodeType === 1) {
            if (shouldSkipElement(n)) return filter.FILTER_REJECT;
            return filter.FILTER_SKIP;
          }
          var p = n.parentElement;
          if (!p || shouldSkipElement(p)) return filter.FILTER_REJECT;
          return filter.FILTER_ACCEPT;
        }
      });
    } catch (e) {
      return 0;
    }
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) count += translateTextNode(n);
    }

    var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      count += translateAttrs(el);
      if (el.shadowRoot) {
        count += scanNode(el.shadowRoot);
        observeRoot(el.shadowRoot);
      }
      if (el.tagName === 'IFRAME') attachFrame(el);
    }
    return count;
  }

  function attachFrame(frame) {
    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body) return;
    if (!doc.__cepZhAttached) {
      doc.__cepZhAttached = true;
      attachedDocs.push(doc);
      observeRoot(doc);
    }
    // Always rescan: outer code may have restored or replaced the frame text.
    scanNode(doc.body);
  }

  function fullScan() {
    if (scanning) return;
    scanning = true;
    try {
      if (document.body) scanNode(document.body);
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) attachFrame(frames[i]);
    } finally {
      scanning = false;
    }
  }

  function attachChildWindow(win) {
    if (!win) return;
    try {
      var doc = win.document;
      if (!doc || !doc.body) return;
      if (!doc.__cepZhAttached) {
        doc.__cepZhAttached = true;
        attachedDocs.push(doc);
        observeRoot(doc);
      }
      scanNode(doc.body);
      var frames = doc.querySelectorAll ? doc.querySelectorAll('iframe') : [];
      for (var i = 0; i < frames.length; i++) attachFrame(frames[i]);
    } catch (e) {
      // Cross-origin popups are intentionally left to the Agent/CEP target.
      lastError = 'popup: ' + String(e && e.message || e);
    }
  }

  function installChildWindowHook() {
    if (window.__cepZhOpenHooked || typeof window.open !== 'function') return;
    window.__cepZhOpenHooked = true;
    var rawOpen = window.open;
    var hooked = function () {
      var win = rawOpen.apply(window, arguments);
      if (win) {
        setTimeout(function () { attachChildWindow(win); }, 350);
        try {
          win.addEventListener('load', function () { attachChildWindow(win); }, true);
        } catch (e) {}
      }
      return win;
    };
    try {
      window.open = hooked;
    } catch (e) {
      lastError = 'window.open: ' + String(e && e.message || e);
    }
  }

  var pending = [];
  function processNode(node) {
    if (!enabled || !node || node.nodeType === undefined) return;
    if (!node.isConnected) return;
    if (node.nodeType === 3) translateTextNode(node);
    else if (node.nodeType === 1) {
      scanNode(node);
      var frames = node.querySelectorAll ? node.querySelectorAll('iframe') : [];
      for (var k = 0; k < frames.length; k++) attachFrame(frames[k]);
    }
  }

  // MutationObserver callbacks already run as microtasks; translate synchronously
  // so frameworks that rewrite text every frame never show an English flash.
  function schedule(nodes) {
    for (var i = 0; i < nodes.length; i++) pending.push(nodes[i]);
    var batch = pending;
    pending = [];
    for (var j = 0; j < batch.length; j++) processNode(batch[j]);
  }

  function onMutations(mutations) {
    mutationCount++;
    if (!enabled) return;
    try {
      var nodes = [];
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'characterData') {
          translateTextNode(m.target);
        } else if (m.type === 'attributes') {
          translateAttrs(m.target);
        } else if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var node = m.addedNodes[j];
            if (node.nodeType === 1 || node.nodeType === 3) nodes.push(node);
          }
        }
      }
      if (nodes.length) schedule(nodes);
    } catch (e) {
      lastError = String(e && e.message || e);
    }
  }

  function observeRoot(root) {
    if (!root || root.__cepZhObs) return;
    try {
      var obs = new MutationObserver(onMutations);
      obs.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS.concat(['value'])
      });
      root.__cepZhObs = obs;
      observedRoots.push(root);
      observers.push(obs);
    } catch (e) {
      lastError = 'observe: ' + String(e && e.message || e);
    }
  }

  function restore() {
    enabled = false;
    for (var i = 0; i < observers.length; i++) { try { observers[i].disconnect(); } catch (e) {} }
    observers = [];
    for (var r = 0; r < observedRoots.length; r++) {
      try { observedRoots[r].__cepZhObs = null; } catch (e) {}
    }
    observedRoots = [];
    for (var d = 0; d < attachedDocs.length; d++) {
      try { attachedDocs[d].__cepZhAttached = false; } catch (e) {}
    }
    attachedDocs = [];
    for (var t = 0; t < timers.length; t++) {
      try { clearInterval(timers[t]); } catch (e) {}
    }
    timers = [];
    for (var j = 0; j < textNodes.length; j++) {
      try { textNodes[j].nodeValue = originalText[j]; } catch (e) {}
      try { originalTextMap.delete(textNodes[j]); } catch (e) {}
    }
    for (var k = 0; k < attrEls.length; k++) {
      var el = attrEls[k], orig = originalAttrs[k] || {};
      for (var name in orig) {
        if (!Object.prototype.hasOwnProperty.call(orig, name)) continue;
        try {
          if (name === '@value') el.value = orig[name];
          else el.setAttribute(name, orig[name]);
        } catch (e) {}
      }
      try { originalAttrMap.delete(el); } catch (e) {}
    }
    textNodes = []; originalText = []; attrEls = []; originalAttrs = [];
  }

  function enable() {
    if (enabled) { fullScan(); return; }
    enabled = true;
    observeRoot(document.documentElement);
    fullScan();
  }

  installChildWindowHook();

  if (window.__CEP_ZH__ && window.__CEP_ZH__.version === VERSION) {
    window.__CEP_ZH__.dict = dict;
    window.__CEP_ZH__.patterns = patterns;
    var prevStats = window.__CEP_ZH__.stats ? window.__CEP_ZH__.stats() : null;
    if (prevStats && prevStats.enabled === false && window.__CEP_ZH__.enable) {
      try { window.__CEP_ZH__.enable(); } catch (e) {}
    }
    window.__CEP_ZH__.scan();
    return;
  }

  // A newer runtime replaces the old one without requiring a page reload.
  if (window.__CEP_ZH__ && window.__CEP_ZH__.version && window.__CEP_ZH__.off) {
    try { window.__CEP_ZH__.off(); } catch (e) {}
  }

  window.__CEP_ZH__ = {
    version: VERSION,
    extId: CFG.extId || '',
    bundleId: CFG.bundleId || '',
    dict: dict,
    patterns: patterns,
    scan: function () { fullScan(); return changedCount; },
    stats: function () {
      return {
        changed: changedCount,
        textNodes: textNodes.length,
        attrElements: attrEls.length,
        enabled: enabled,
        mutations: mutationCount,
        observedRoots: observedRoots.length,
        lastError: lastError,
        activityEpoch: activityEpoch,
        activityKind: activityKind,
        activityAt: lastActivityAt,
        href: location.href,
        // Cheap content signature: the Agent's safety-net capture uses it to
        // notice a page switch that emitted no activity hint at all.
        textLen: (document.body && document.body.textContent) ? document.body.textContent.length : 0,
        focused: document.hasFocus ? document.hasFocus() : false,
        hidden: !!document.hidden
      };
    },
    off: restore,
    enable: enable,
    // English sources of the nodes/attributes this instance translated. The
    // Agent's capture reads these instead of calling off(), so capturing no
    // longer reverts the panel to English for a frame.
    originalTextFor: function (node) {
      try { return originalTextMap.get(node) || null; } catch (e) { return null; }
    },
    originalAttrFor: function (el, name) {
      try {
        var map = originalAttrMap.get(el);
        return (map && Object.prototype.hasOwnProperty.call(map, name)) ? map[name] : null;
      } catch (e) { return null; }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      observeRoot(document.documentElement);
      fullScan();
    }, { once: true });
  } else {
    observeRoot(document.documentElement);
    fullScan();
  }

  // Catch iframes that load later and shadow roots created by frameworks.
  document.addEventListener('load', function (ev) {
    var t = ev.target;
    if (t && t.tagName === 'IFRAME') attachFrame(t);
  }, true);

  // Focus/visibility/route changes are hints for the Agent's incremental
  // capture. They are deliberately independent from translation state.
  window.addEventListener('focus', function () { markActivity('focus'); }, true);
  window.addEventListener('hashchange', function () { markActivity('route'); }, true);
  window.addEventListener('popstate', function () { markActivity('route'); }, true);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) markActivity('visible');
  }, true);

  // Every panel switches its internal pages differently: some use ARIA tabs,
  // some use plain buttons, some re-render on any click. Marking *any*
  // interaction (throttled) is what lets the Agent notice Motion 4-style
  // switches; the Agent debounces and rate-limits the actual captures.
  var lastInteractionAt = 0;
  function markInteraction(kind) {
    var now = Date.now();
    if (now - lastInteractionAt < 400) return;
    lastInteractionAt = now;
    markActivity(kind);
  }
  function isTabTarget(t) {
    return !!(t && t.closest && t.closest('[role="tab"], [data-tab], [aria-selected], .tab, .nav-tabs, .nav-item'));
  }
  document.addEventListener('pointerdown', function (ev) {
    if (ev && (ev.button === 2 || ev.button === 1)) return;
    markInteraction(isTabTarget(ev && ev.target) ? 'tab' : 'press');
  }, true);
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (isTabTarget(t)) { markActivity('tab'); return; }
    markInteraction('click');
  }, true);
  // Inner focus changes happen when a panel swaps sections without a click
  // reaching our handler (e.g. focus moved by script). Typing inside a field is
  // not a page switch, so inputs are ignored.
  document.addEventListener('focusin', function (ev) {
    var t = ev && ev.target;
    var tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    markInteraction('focusin');
  }, true);
  // Scrolling brings new rows into view; with viewport-only capture the Agent
  // needs this hint to collect the rows that just became visible.
  window.addEventListener('scroll', function () { markInteraction('scroll'); }, true);

  timers.push(setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      markActivity('route');
    }
    if (!enabled) return;
    if (document.body) scanNode(document.body);
  }, 2500));

  window.addEventListener('beforeunload', function () {
    for (var i = 0; i < timers.length; i++) clearInterval(timers[i]);
  });
})();

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
  var VERSION = '1.0.0';
  var dict = CFG.dict || {};
  var patterns = [];

  (CFG.patterns || []).forEach(function (p) {
    try { patterns.push({ re: new RegExp(p.re, p.flags || ''), to: p.to }); } catch (e) { /* ignore bad rule */ }
  });

  function lookup(key) {
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(dict, key) && dict[key]) return dict[key];
    var compact = key.replace(/\s+/g, ' ').trim();
    if (compact !== key && Object.prototype.hasOwnProperty.call(dict, compact) && dict[compact]) return dict[compact];
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
  var ATTRS = CFG.attrs || ['title', 'placeholder', 'aria-label', 'aria-placeholder', 'alt', 'data-pt-title', 'tooltip'];

  var textNodes = [];        // changed text nodes, for off()
  var attrEls = [];          // changed elements, for off()
  var originalText = [];     // parallel to textNodes: original values
  var originalAttrs = [];    // parallel to attrEls: {attr: value}
  var changedCount = 0;
  var mutationCount = 0;
  var lastError = '';
  var scanning = false;
  var observers = [];
  var observedRoots = [];
  var attachedDocs = [];
  var timers = [];
  var enabled = true;

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
    }
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
      if (!Object.prototype.hasOwnProperty.call(originalAttrs[pos], name)) originalAttrs[pos][name] = value;
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
            if (!Object.prototype.hasOwnProperty.call(originalAttrs[p], '@value')) originalAttrs[p]['@value'] = val;
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
        attributeFilter: ATTRS
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
    }
    textNodes = []; originalText = []; attrEls = []; originalAttrs = [];
  }

  function enable() {
    if (enabled) { fullScan(); return; }
    enabled = true;
    observeRoot(document.documentElement);
    fullScan();
  }

  if (window.__CEP_ZH__ && window.__CEP_ZH__.version) {
    window.__CEP_ZH__.dict = dict;
    window.__CEP_ZH__.patterns = patterns;
    var prevStats = window.__CEP_ZH__.stats ? window.__CEP_ZH__.stats() : null;
    if (prevStats && prevStats.enabled === false && window.__CEP_ZH__.enable) {
      try { window.__CEP_ZH__.enable(); } catch (e) {}
    }
    window.__CEP_ZH__.scan();
    return;
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
        lastError: lastError
      };
    },
    off: restore,
    enable: enable
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

  timers.push(setInterval(function () {
    if (!enabled) return;
    if (document.body) scanNode(document.body);
  }, 2500));

  window.addEventListener('beforeunload', function () {
    for (var i = 0; i < timers.length; i++) clearInterval(timers[i]);
  });
})();

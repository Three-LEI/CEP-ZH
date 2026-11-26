// Extract translatable strings from a live panel (shared by catalog command and agent).
import fs from 'node:fs';
import path from 'node:path';

export const EXTRACT_EXPR = String.raw`(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','CODE','PRE','SVG','CANVAS','TEXTAREA']);
  const ATTRS = [
    'title','placeholder','aria-label','aria-placeholder','aria-description',
    'aria-roledescription','aria-valuetext','alt','tooltip','data-pt-title',
    'data-tooltip','data-title','data-tip','data-original-title',
    'data-placeholder','label'
  ];
  const runtime = window.__CEP_ZH__;
  const opts = window.__CEP_ZH_EXTRACT_OPTS__ || {};
  const viewportOnly = !!opts.viewportOnly;
  // "Only the current viewport": skip content scrolled out of view (or hidden by
  // a zero-size box). Costs a layout read per element, so it is opt-in.
  const inViewport = (el) => {
    if (!viewportOnly) return true;
    if (!el || !el.getBoundingClientRect) return true;
    try {
      const r = el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return false;
      const vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
      const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    } catch (e) {
      return true;
    }
  };
  // The runtime keeps the English source of every node it translated. Reading it
  // means a capture never has to call off() and revert the panel to English.
  const sourceText = (n) => {
    try {
      if (runtime && runtime.originalTextFor) {
        const o = runtime.originalTextFor(n);
        if (o != null && o !== '') return o;
      }
    } catch (e) {}
    return n.textContent == null ? '' : n.textContent;
  };
  const sourceAttr = (el, name) => {
    try {
      if (runtime && runtime.originalAttrFor) {
        const o = runtime.originalAttrFor(el, name);
        if (o != null && o !== '') return o;
      }
    } catch (e) {}
    try { return name === '@value' ? el.value : el.getAttribute(name); } catch (e) { return null; }
  };
  const text = new Map(), attrs = new Map();
  const seen = new Set();
  // Structure hints for the "visible English that never gets captured" case:
  // text inside a cross-origin iframe, a closed shadow root or a canvas is not
  // reachable by a DOM walk, and these counters make that visible in the log.
  const domInfo = { iframes: 0, iframesBlocked: 0, shadowRoots: 0, canvases: 0 };
  // Diagnostics: why did a Latin-looking text node not get captured? Kept tiny
  // (max 5 samples) and only reported in the capture trace.
  const rejectCounts = {};
  const rejectSamples = [];
  const rejectNote = (reason, value) => {
    rejectCounts[reason] = (rejectCounts[reason] || 0) + 1;
    if (rejectSamples.length >= 5) return;
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (!s || s.length > 80) return;
    if (!/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(s)) return;
    rejectSamples.push(reason + ':' + s);
  };
  // Already-Chinese text that only carries a short Latin token (kaomoji like
  // "OwO", brand suffix like "&BCC") is not a translatable UI string.
  const cjkHeavy = (s) => {
    const han = (s.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) || []).length;
    if (han < 2) return false;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    return latin <= Math.max(2, Math.floor(han / 2));
  };
  const bump = (map, key) => {
    const k = String(key == null ? '' : key).replace(/\s+/g, ' ').trim();
    if (!k) return;
    // Keep only strings with translatable Latin letters: skips pure Chinese,
    // pure numbers and pure punctuation/symbols. U+00D7/U+00F7 are excluded.
    if (!/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(k)) return;
    if (cjkHeavy(k)) { rejectNote('cjk-heavy', k); return; }
    // Skip obvious CSS/SVG/JS fragments that some panels keep in text nodes,
    // but keep template placeholders such as "{0}" and "{name}".
    if (/[{}]/.test(k) && !/\{[A-Za-z0-9_.-]+\}/.test(k)) { rejectNote('braces', k); return; }
    if (/(?:fill|stroke|font-size|font-family|background|opacity|color|margin|padding|display)\s*:/i.test(k)) { rejectNote('css', k); return; }
    if (/^(?:https?|file):\/\//i.test(k)) { rejectNote('url', k); return; }
    map.set(k, (map.get(k) || 0) + 1);
  };
  function visit(root) {
    if (!root || seen.has(root)) return;
    seen.add(root);
    const doc = root.ownerDocument || (root.nodeType === Node.DOCUMENT_NODE ? root : document);
    const win = doc.defaultView || window;
    const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT | win.NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === win.Node.ELEMENT_NODE) {
          if (SKIP.has(n.tagName)) {
            rejectNote('skip-tag', n.textContent);
            return win.NodeFilter.FILTER_REJECT;
          }
          return win.NodeFilter.FILTER_SKIP;
        }
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) { rejectNote('skip-parent', n.textContent); return win.NodeFilter.FILTER_REJECT; }
        if (p.closest('[contenteditable="true"], .notranslate, [translate="no"]')) {
          rejectNote('notranslate', n.textContent);
          return win.NodeFilter.FILTER_REJECT;
        }
        if (!inViewport(p)) { rejectNote('viewport', n.textContent); return win.NodeFilter.FILTER_REJECT; }
        const t = sourceText(n).replace(/\s+/g, ' ').trim();
        if (!t) return win.NodeFilter.FILTER_REJECT;
        if (t.length > 160) { rejectNote('too-long', t); return win.NodeFilter.FILTER_REJECT; }
        if (!/[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/.test(t)) {
          rejectNote('no-latin', t);
          return win.NodeFilter.FILTER_REJECT;
        }
        return win.NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) if (n.nodeType === win.Node.TEXT_NODE) bump(text, sourceText(n));
    for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) {
      const visible = inViewport(el);
      if (el.tagName === 'CANVAS') domInfo.canvases++;
      if (visible) {
        for (const a of ATTRS) if (el.hasAttribute(a)) bump(attrs, sourceAttr(el, a));
        if (el.tagName === 'INPUT') {
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (type === 'button' || type === 'submit' || type === 'reset') bump(attrs, sourceAttr(el, '@value'));
        }
      }
      if (el.shadowRoot) {
        domInfo.shadowRoots++;
        visit(el.shadowRoot);
      }
      if (el.tagName === 'IFRAME') {
        domInfo.iframes++;
        let frameDoc = null;
        try { frameDoc = el.contentDocument; } catch (e) { frameDoc = null; }
        if (!frameDoc) domInfo.iframesBlocked++;
        else if (visible) {
          try { visit(frameDoc.body); } catch (e) {}
        }
      }
    }
  }
  visit(document.body);
  return JSON.stringify({
    title: document.title,
    url: location.href,
    text: [...text.entries()],
    attrs: [...attrs.entries()],
    rejected: { counts: rejectCounts, samples: rejectSamples.slice(0, 5) },
    dom: domInfo
  });
})()`;

export function mergeCatalog(existing, extracted, meta) {
  const out = existing || {
    bundleId: meta.bundleId || '',
    extIds: [],
    title: '',
    url: '',
    updatedAt: '',
    strings: {},
    attrs: {},
  };
  out.title = extracted.title || out.title;
  out.url = extracted.url || out.url;
  out.updatedAt = new Date().toISOString();
  if (meta.extId && !out.extIds.includes(meta.extId)) out.extIds.push(meta.extId);
  for (const [s, count] of extracted.text) out.strings[s] = (out.strings[s] || 0) + count;
  for (const [s, count] of extracted.attrs) out.attrs[s] = (out.attrs[s] || 0) + count;
  return out;
}

export function catalogPathFor(dir, key) {
  const safe = String(key || 'unknown').replace(/[^\w.-]+/g, '_');
  return path.join(dir, safe + '.json');
}

export function saveCatalog(dir, key, catalog) {
  fs.mkdirSync(dir, { recursive: true });
  const file = catalogPathFor(dir, key);
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2), 'utf8');
  return file;
}
